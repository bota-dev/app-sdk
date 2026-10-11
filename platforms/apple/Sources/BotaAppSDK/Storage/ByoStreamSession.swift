import CryptoKit
import Foundation

/// Ciphertext-only live delivery; Batch still owns authorization and cleanup.
actor ByoStreamSession {
    private let options: ByoStorageOptions
    private let recording: ByoRecording
    private let ble: any ByoDeviceLink
    private let http: any ByoControlClient
    private let refresh: @Sendable () async throws -> Void
    private let store: ByoDurableStore
    private let identity: Data
    private let scope: Data
    private var docs: [String: Any]
    init(options: ByoStorageOptions, recording: ByoRecording, ble: any ByoDeviceLink, http: any ByoControlClient,
         refresh: @escaping @Sendable () async throws -> Void) throws {
        self.options = options; self.recording = recording; self.ble = ble; self.http = http; self.refresh = refresh
        guard let uuid = UUID(uuidString: recording.uuid), uuid.uuidString.lowercased() == recording.uuid else { throw ByoFailure.invalidConfiguration }
        var value = uuid.uuid; var generation = recording.generation.littleEndian
        identity = withUnsafeBytes(of: &value) { Data($0) } + withUnsafeBytes(of: &generation) { Data($0) }
        scope = try byoJSON(["origin": options.baseURL.absoluteString, "scope": options.scopeKey, "organization": options.organizationID,
            "project": options.projectID, "device": options.deviceID, "environment": options.environment, "binding": options.bindingGeneration,
            "recording": recording.uuid, "generation": recording.generation])
        store = try ByoDurableStore(root: options.stateDirectory.appendingPathComponent("stream/" + Self.hash(scope), isDirectory: true))
        docs = try store.load("documents").map(byoObject) ?? [:]
    }
    private static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func persist() throws { try store.save("documents", byoJSON(docs)) }
    private func rpc(_ op: UInt64, _ body: Data? = nil) async throws -> Data {
        try Task.checkCancellation(); try await options.validateScope()
        do { return try await ble.call(op, body ?? identity) }
        catch ByoFailure.contextExpired { try await refresh(); return try await ble.call(op, body ?? identity) }
    }
    private func number(_ object: [String: Any], _ key: String) throws -> UInt32 {
        guard let n = object[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue >= 0,
              n.doubleValue <= Double(UInt32.max), n.doubleValue == Double(n.uint32Value) else { throw ByoFailure.protocolViolation }
        return n.uint32Value
    }
    private func validate(_ context: [String: Any]) throws {
        guard context["recording_uuid"] as? String == recording.uuid, try number(context, "recording_generation") == recording.generation,
              context["organization_id"] as? String == options.organizationID, context["project_id"] as? String == options.projectID,
              context["device_id"] as? String == options.deviceID, context["environment"] as? String == options.environment,
              try number(context, "binding_generation") == options.bindingGeneration, context["channel"] as? String == "ble",
              let id = context["upload_session_id"] as? String, UUID(uuidString: id)?.uuidString.lowercased() == id else { throw ByoFailure.identityConflict }
    }
    private func le32(_ value: UInt32) -> Data { var n = value.littleEndian; return withUnsafeBytes(of: &n) { Data($0) } }
    func run() async throws -> ByoUploadResult {
        var socket: (any ByoStreamSocket)?
        do {
            try await refresh()
            if let old = docs["scope"] as? String, old != scope.base64EncodedString() { throw ByoFailure.identityConflict }
            docs["scope"] = scope.base64EncodedString()
            if let seed = docs["successor"] as? [String: Any], let context = seed["context"] as? [String: Any] {
                try validate(context)
                let result = try await ByoUploadSession(options: options, recording: recording, ble: ble, http: http, refresh: refresh, successor: byoJSON(seed)).run()
                try store.removeCiphertext(); return result
            }
            var capability = try byoObject(await rpc(1, Data()))
            guard (capability["upload_modes"] as? [String])?.contains("http_segments") == true else { throw ByoFailure.protocolViolation }
            capability["upload_modes"] = ["whole_file", "http_segments", "ws_relay"]; capability["durable_source"] = true; capability["durable_receipt"] = true
            let selection = try byoDataObject(await http.control("/capabilities", body: byoJSON(capability)))
            var facts = try byoObject(await rpc(9))
            if docs["selected"] == nil, facts["stream_selected"] as? Bool != true,
               (selection["destination"] as? [String: Any])?["kind"] as? String != "customer" { throw ByoFailure.notSelected }
            let resumed = docs["selected"] != nil || facts["stream_selected"] as? Bool == true
            guard let allowed = selection["upload_modes"] as? [String], resumed || (allowed.contains("whole_file") && allowed.contains("http_segments")) else { throw ByoFailure.protocolViolation }
            docs["selected"] = true; try persist(); facts = try byoObject(await rpc(9, identity + Data([1])))
            let context: [String: Any]
            if let saved = docs["context"] as? [String: Any] ?? facts["stream_context"] as? [String: Any] { context = saved }
            else {
                let created = try byoDataObject(await http.streamControl("", body: byoJSON(["recording_uuid": recording.uuid,
                    "recording_generation": recording.generation, "channel": "ble", "source_mode": "durable", "limits_profile": "byo-stream-128m-4h-v1"])))
                guard let value = created["context"] as? [String: Any] else { throw ByoFailure.protocolViolation }; context = value
            }
            try validate(context); docs["context"] = context; try persist(); _ = try await rpc(12, identity + byoJSON(context))
            let session = context["upload_session_id"] as! String; let endpoint = "/" + session
            var fallback = resumed || docs["fallback"] as? Bool == true
            var offset: UInt32 = 0; var index: UInt32 = 0
            let started = ByoContinuousInstant.now; var refreshed = started
            if !fallback {
                do { if allowed.contains("ws_relay") { socket = try await http.streamSocket(session) } }
                catch { try Task.checkCancellation(); socket = nil }
                docs["transport"] = socket == nil ? "http" : "ws"; try persist()
            }
            while true {
                try Task.checkCancellation()
                guard started.seconds(to: .now) < 14400 else { throw ByoFailure.pending }
                if refreshed.seconds(to: .now) > 30 { try await refresh(); refreshed = .now }
                facts = try byoObject(await rpc(9))
                guard facts["recording_uuid"] as? String == recording.uuid, try number(facts, "recording_generation") == recording.generation,
                      facts["failed"] as? Bool == false else { throw ByoFailure.identityConflict }
                let length = try number(facts, "ciphertext_length")
                guard length >= offset, length <= 134217728, let closed = facts["closed"] as? Bool else { throw ByoFailure.protocolViolation }
                if facts["overflow"] as? Bool == true {
                    fallback = true
                } else if try number(facts, "retained_offset") > offset {
                    fallback = true
                }
                let count = min(16384, length - offset)
                if !fallback && count > 0 && (count == 16384 || closed) {
                    do {
                        var bytes = Data(); bytes.reserveCapacity(Int(count))
                        while bytes.count < count {
                            var size = UInt16(min(4096, Int(count) - bytes.count)).littleEndian
                            let chunk = try await rpc(10, identity + le32(offset + UInt32(bytes.count)) + withUnsafeBytes(of: &size) { Data($0) })
                            guard chunk.count == Int(UInt16(littleEndian: size)) else { throw ByoFailure.protocolViolation }; bytes.append(chunk)
                        }
                        let segment = try byoJSON(["index": index, "offset": offset, "length": count, "sha256": Self.hash(bytes)])
                        if docs["transport"] as? String == "ws" {
                            while true {
                                do { guard let socket else { throw ByoFailure.pending }; _ = try await socket.exchange(segment, bytes: bytes); break }
                                catch {
                                    try Task.checkCancellation(); await socket?.close(); socket = nil
                                    let retries = docs["reconnects"] as? Int ?? 0
                                    guard retries < 3 else { throw error }
                                    docs["reconnects"] = retries + 1; try persist()
                                    try await Task.sleep(nanoseconds: 1_000_000_000 << retries)
                                    do { socket = try await http.streamSocket(session) } catch { try Task.checkCancellation() }
                                }
                            }
                        } else {
                            let granted = try byoDataObject(await http.streamControl(endpoint + "/grants", body: segment))
                            guard var proof = granted["result"] as? [String: Any], let descriptor = proof["segment"] as? [String: Any],
                                  try byoJSON(descriptor) == segment else { throw ByoFailure.protocolViolation }
                            if proof["state"] as? String != "confirmed" {
                                guard proof["state"] as? String == "write_authorized", let grant = proof["grant"] as? [String: Any] else { throw ByoFailure.protocolViolation }
                                let file = try store.createCiphertext(); do { try file.write(contentsOf: bytes); try file.synchronize(); try file.close() } catch { try? file.close(); throw error }
                                try await http.put(byoJSON(grant), file: store.root.appendingPathComponent("ciphertext"))
                                let confirmed = try byoDataObject(await http.streamControl(endpoint + "/confirm", body: segment))
                                guard let value = confirmed["result"] as? [String: Any] else { throw ByoFailure.protocolViolation }; proof = value
                            }
                            guard proof["state"] as? String == "confirmed", let confirmed = proof["segment"] as? [String: Any],
                                  try byoJSON(confirmed) == segment else { throw ByoFailure.protocolViolation }
                        }
                        offset += count; index += 1; _ = try await rpc(11, identity + le32(offset))
                    } catch {
                        try Task.checkCancellation(); fallback = true; docs["fallback"] = true; try persist(); await socket?.close(); socket = nil
                    }
                }
                if closed && (fallback || offset == length) { break }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            await socket?.close(); socket = nil
            var status = try byoDataObject(await http.streamControl(endpoint, body: nil))
            if status["recovery_required"] as? Bool == true {
                let revision = try number(status, "recovery_revision")
                var operation = docs["renewal"] as? [String: Any] ?? [:]
                if operation["expected_revision"] as? UInt32 != revision { operation = ["operation_id": UUID().uuidString.lowercased(), "expected_revision": revision] }
                docs["renewal"] = operation; try persist()
                _ = try await http.streamControl(endpoint + "/recover", body: byoJSON(operation))
                status = try byoDataObject(await http.streamControl(endpoint, body: nil))
            }
            if status["phase"] as? String != "handed_off" {
                let length = try number(facts, "ciphertext_length")
                let pending = status["pending"] as? [String: Any]
                let mode = (pending?["operation"] as? String == "handoff" ? pending?["mode"] as? String : nil)
                    ?? (docs["handoff"] as? [String: Any])?["mode"] as? String ?? (!fallback && offset == length ? "assembled" : "whole_file")
                guard let hash = facts["ciphertext_sha256"] as? String else { throw ByoFailure.protocolViolation }
                let body: [String: Any] = ["mode": mode, "final": ["ciphertext_length": length, "ciphertext_sha256": hash, "segment_count": (length + 16383) / 16384]]
                if let old = docs["handoff"] as? [String: Any], try byoJSON(old) != byoJSON(body) { throw ByoFailure.identityConflict }
                docs["handoff"] = body; try persist(); status = try byoDataObject(await http.streamControl(endpoint + "/handoff", body: byoJSON(body)))
            }
            guard let successor = status["successor"] as? [String: Any], let mode = status["handoff_mode"] as? String,
                  ["assembled", "whole_file"].contains(mode) else { throw ByoFailure.protocolViolation }
            try validate(successor)
            let seed = try byoJSON(["context": successor, "mode": mode]); docs["successor"] = try byoObject(seed); try persist()
            _ = try await rpc(13, identity + seed)
            let result = try await ByoUploadSession(options: options, recording: recording, ble: ble, http: http, refresh: refresh, successor: seed).run()
            try store.removeCiphertext(); return result
        } catch { await socket?.close(); throw error }
    }
}
