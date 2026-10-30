import CryptoKit
import Foundation
import Network
import Security

public enum LocalWiFiTransportError: Error, Sendable {
    case unavailable, invalidInput, invalidCertificate, invalidResponse, busy, closed, timeout
}

/// HTTP framing only. The shared Rust receiver validates Range, length and ETag.
struct LocalWiFiHTTPHeaders: Equatable, Sendable {
    let status: Int
    let fields: [String: String]
    let body: Data

    static func parse(_ bytes: Data) throws -> Self? {
        guard let boundary = bytes.range(of: Data([13, 10, 13, 10])) else {
            if bytes.count > 16_384 { throw LocalWiFiTransportError.invalidResponse }
            return nil
        }
        guard boundary.lowerBound <= 16_384,
              let text = String(data: bytes[..<boundary.lowerBound], encoding: .ascii) else {
            throw LocalWiFiTransportError.invalidResponse
        }
        let lines = text.components(separatedBy: "\r\n")
        let status = lines[0].split(separator: " ", maxSplits: 2)
        guard status.count >= 2, status[0] == "HTTP/1.1", status[1].count == 3,
              let code = Int(status[1]), (100...599).contains(code) else { throw LocalWiFiTransportError.invalidResponse }
        var fields: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else { throw LocalWiFiTransportError.invalidResponse }
            let name = String(line[..<colon]).lowercased()
            guard name.utf8.allSatisfy({ (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }),
                  fields[name] == nil else { throw LocalWiFiTransportError.invalidResponse }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard value.utf8.allSatisfy({ $0 == 9 || (32...126).contains($0) }) else { throw LocalWiFiTransportError.invalidResponse }
            fields[name] = value
        }
        // No chunked or connection-delimited bodies, automatic decompression or redirects.
        guard fields["transfer-encoding"] == nil, let length = fields["content-length"],
              !length.isEmpty, length.utf8.allSatisfy({ (48...57).contains($0) }), UInt64(length) != nil else {
            throw LocalWiFiTransportError.invalidResponse
        }
        return Self(status: code, fields: fields, body: Data(bytes[boundary.upperBound...]))
    }
}

/// Extract the exact DER SPKI; raw SecKey bytes are not a SubjectPublicKeyInfo.
enum LocalWiFIPin {
    private struct Item { let tag: UInt8; let start: Int; let body: Int; let end: Int }
    static func subjectPublicKeyInfo(_ certificate: Data) throws -> Data {
        let bytes = [UInt8](certificate)
        func item(_ start: Int, _ limit: Int) throws -> Item {
            guard start >= 0, start + 2 <= limit, limit <= bytes.count else { throw LocalWiFiTransportError.invalidCertificate }
            var cursor = start + 2
            var length = Int(bytes[start + 1])
            if length & 128 != 0 {
                let count = length & 127
                guard (1...4).contains(count), cursor + count <= limit, bytes[cursor] != 0 else { throw LocalWiFiTransportError.invalidCertificate }
                length = 0
                for byte in bytes[cursor..<(cursor + count)] { length = length * 256 + Int(byte) }
                guard length >= 128 else { throw LocalWiFiTransportError.invalidCertificate }
                cursor += count
            }
            guard length <= limit - cursor else { throw LocalWiFiTransportError.invalidCertificate }
            return Item(tag: bytes[start], start: start, body: cursor, end: cursor + length)
        }
        let outer = try item(0, bytes.count)
        guard outer.tag == 0x30, outer.end == bytes.count else { throw LocalWiFiTransportError.invalidCertificate }
        let tbs = try item(outer.body, outer.end)
        guard tbs.tag == 0x30 else { throw LocalWiFiTransportError.invalidCertificate }
        var current = try item(tbs.body, tbs.end)
        if current.tag == 0xa0 { current = try item(current.end, tbs.end) }
        guard current.tag == 0x02 else { throw LocalWiFiTransportError.invalidCertificate }
        // Serial, signature, issuer, validity, subject; SPKI follows.
        for _ in 0..<5 { current = try item(current.end, tbs.end) }
        guard current.tag == 0x30 else { throw LocalWiFiTransportError.invalidCertificate }
        return Data(bytes[current.start..<current.end])
    }
    static func matches(_ trust: SecTrust, pin: Data) -> Bool {
        guard pin.count == 32, let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let certificate = chain.first,
              let spki = try? subjectPublicKeyInfo(SecCertificateCopyData(certificate) as Data) else { return false }
        let digest = Data(SHA256.hash(data: spki))
        return zip(digest, pin).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}

/// A single pinned TLS 1.3 socket, explicitly routed over WiFi. No global routing changes.
/// All connection state and continuations are confined to queue.
public final class LocalWiFiHTTP: @unchecked Sendable {
    public struct Response: Sendable {
        public let status: Int
        public let headers: [String: String]
    }
    private let queue = DispatchQueue(label: "dev.bota.local-wifi.socket")
    private let authority: String
    private let connection: NWConnection
    private let deadline: DispatchTime
    private var ready: CheckedContinuation<Void, any Error>?
    private var closing: [CheckedContinuation<Void, Never>] = []
    private var stopped = false
    private var started = false
    private var opened = false
    private var failure: (any Error)?
    private var remainder = Data()
    private var eof = false
    private var reading = false
    private var pendingIO = 0
    private var timer: DispatchWorkItem?

    public init(ipv4: String, port: UInt16, spkiSHA256: Data, deadline: DispatchTime) throws {
        guard IPv4Address(ipv4) != nil, port > 0, spkiSHA256.count == 32 else { throw LocalWiFiTransportError.invalidInput }
        self.deadline = deadline
        authority = "\(ipv4):\(port)"
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv13)
        sec_protocol_options_set_max_tls_protocol_version(tls.securityProtocolOptions, .TLSv13)
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
            complete(LocalWiFIPin.matches(sec_trust_copy_ref(trust).takeRetainedValue(), pin: spkiSHA256))
        }, queue)
        let parameters = NWParameters(tls: tls)
        parameters.requiredInterfaceType = .wifi
        connection = NWConnection(host: NWEndpoint.Host(ipv4), port: NWEndpoint.Port(rawValue: port)!, using: parameters)
    }
    public func open(path: String, offset: String, etag: String, bearer: String) async throws -> Response {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), path.utf8.allSatisfy({ (33...126).contains($0) && $0 != 35 }),
              !offset.isEmpty, offset.utf8.allSatisfy({ (48...57).contains($0) }), UInt64(offset) != nil,
              !bearer.isEmpty, bearer.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }),
              etag.utf8.allSatisfy({ (32...126).contains($0) }) else { throw LocalWiFiTransportError.invalidInput }
        // A rejected second open must not cancel the first caller's socket.
        let claimed = await withCheckedContinuation { done in queue.async {
            guard !self.opened, !self.stopped else { done.resume(returning: false); return }
            self.opened = true; done.resume(returning: true)
        } }
        guard claimed else { throw LocalWiFiTransportError.busy }
        return try await withTaskCancellationHandler {
            do {
                try Task.checkCancellation()
                try await start()
                let range = offset == "0" ? "" : "Range: bytes=\(offset)-\r\nIf-Match: \(etag)\r\n"
                let request = "GET \(path) HTTP/1.1\r\nHost: \(authority)\r\nAuthorization: Bearer \(bearer)\r\nAccept-Encoding: identity\r\nConnection: close\r\n\(range)\r\n"
                try await send(Data(request.utf8))
                var bytes = Data()
                while true {
                    guard let part = try await read(maximumLength: 16_384) else { throw LocalWiFiTransportError.invalidResponse }
                    bytes.append(part)
                    if let headers = try LocalWiFiHTTPHeaders.parse(bytes) {
                        await withCheckedContinuation { done in queue.async { self.remainder = headers.body; done.resume() } }
                        return Response(status: headers.status, headers: headers.fields)
                    }
                }
            } catch { await close(); throw error }
        } onCancel: { self.cancel() }
    }
    public func read(maximumLength: Int) async throws -> Data? {
        guard (1...65_536).contains(maximumLength) else { throw LocalWiFiTransportError.invalidInput }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { done in queue.async {
                if let error = self.failure { done.resume(throwing: error); return }
                guard self.started, !self.stopped else { done.resume(throwing: LocalWiFiTransportError.closed); return }
                guard DispatchTime.now() < self.deadline else { done.resume(throwing: LocalWiFiTransportError.timeout); return }
                guard !self.reading else { done.resume(throwing: LocalWiFiTransportError.busy); return }
                if !self.remainder.isEmpty {
                    let value = Data(self.remainder.prefix(maximumLength)); self.remainder.removeFirst(value.count)
                    done.resume(returning: value); return
                }
                if self.eof { done.resume(returning: nil); return }
                self.reading = true; self.pendingIO += 1; self.armTimeout()
                self.connection.receive(minimumIncompleteLength: 1, maximumLength: maximumLength) { bytes, _, complete, error in
                    defer { self.pendingIO -= 1; self.finishClose() }
                    self.reading = false; self.timer?.cancel(); self.eof = complete
                    if let error = error ?? self.failure { done.resume(throwing: error) }
                    else if let bytes, !bytes.isEmpty { done.resume(returning: bytes) }
                    else if complete { done.resume(returning: nil) }
                    else { done.resume(throwing: LocalWiFiTransportError.invalidResponse) }
                }
            } }
        } onCancel: { self.cancel() }
    }
    public func close() async {
        await withCheckedContinuation { done in queue.async {
            if !self.started { self.stopped = true }
            self.timer?.cancel()
            self.closing.append(done); self.connection.cancel(); self.finishClose()
        } }
    }
    private func finishClose() {
        if stopped && pendingIO == 0 {
            timer?.cancel(); timer = nil
            connection.stateUpdateHandler = nil
            remainder.removeAll()
            closing.forEach { $0.resume() }; closing.removeAll()
        }
    }
    private func cancel() { queue.async {
        self.failure = CancellationError()
        if !self.started { self.stopped = true }
        self.connection.cancel(); self.finishClose()
    } }
    private func armTimeout() {
        timer?.cancel()
        let timer = DispatchWorkItem { self.failure = LocalWiFiTransportError.timeout; self.connection.cancel() }
        self.timer = timer; queue.asyncAfter(deadline: min(.now() + 30, deadline), execute: timer)
    }
    private func start() async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, any Error>) in queue.async {
            guard !self.stopped, !self.started else { done.resume(throwing: LocalWiFiTransportError.closed); return }
            guard DispatchTime.now() < self.deadline else { done.resume(throwing: LocalWiFiTransportError.timeout); return }
            self.started = true
            self.ready = done; self.armTimeout()
            self.connection.stateUpdateHandler = { state in
                switch state {
                case .ready: self.timer?.cancel(); self.ready?.resume(); self.ready = nil
                case .failed(let error): self.failure = error; self.connection.cancel()
                case .cancelled:
                    self.stopped = true; self.timer?.cancel()
                    self.ready?.resume(throwing: self.failure ?? LocalWiFiTransportError.closed); self.ready = nil
                    self.finishClose()
                default: break
                }
            }
            self.connection.start(queue: self.queue)
        } }
    }
    private func send(_ bytes: Data) async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, any Error>) in queue.async {
            guard !self.stopped, self.failure == nil else { done.resume(throwing: self.failure ?? LocalWiFiTransportError.closed); return }
            self.pendingIO += 1; self.armTimeout()
            self.connection.send(content: bytes, completion: .contentProcessed { error in
                defer { self.pendingIO -= 1; self.finishClose() }
                self.timer?.cancel()
                if let error = error ?? self.failure { done.resume(throwing: error) } else { done.resume() }
            })
        } }
    }
}
