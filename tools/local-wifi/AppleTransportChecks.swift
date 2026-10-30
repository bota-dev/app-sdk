import Foundation
import CryptoKit
import Security

@main struct Checks {
    static func main() async throws {
        let header = Data("HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nETag: \"abc\"\r\nContent-Range: bytes 2-4/5\r\n\r\nxyz".utf8)
        let parsed = try LocalWiFiHTTPHeaders.parse(header)
        precondition(parsed?.status == 206)
        precondition(parsed?.fields["content-length"] == "3")
        precondition(parsed?.body == Data("xyz".utf8))
        let partial = try LocalWiFiHTTPHeaders.parse(Data(header.prefix(8)))
        precondition(partial == nil)
        for bad in ["HTTP/1.1 200 OK\r\nContent-Length: 3\r\ncontent-length: 4\r\n\r\n", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"] {
            do { _ = try LocalWiFiHTTPHeaders.parse(Data(bad.utf8)); fatalError("Ambiguous framing accepted") }
            catch LocalWiFiTransportError.invalidResponse { }
        }
        let der = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let expected = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        let spki = try LocalWiFIPin.subjectPublicKeyInfo(der)
        precondition(spki == expected)
        do { _ = try LocalWiFIPin.subjectPublicKeyInfo(Data(der.dropLast())); fatalError("Truncated DER accepted") }
        catch LocalWiFiTransportError.invalidCertificate { }
        let certificate = SecCertificateCreateWithData(nil, der as CFData)!
        var trust: SecTrust?
        precondition(SecTrustCreateWithCertificates(certificate, SecPolicyCreateBasicX509(), &trust) == errSecSuccess)
        precondition(LocalWiFIPin.matches(trust!, pin: Data(SHA256.hash(data: expected))))
        precondition(!LocalWiFIPin.matches(trust!, pin: Data(repeating: 0, count: 32)))
        for _ in 0..<100 {
            let socket = try LocalWiFiHTTP(ipv4: "127.0.0.1", port: 443, spkiSHA256: Data(repeating: 0, count: 32), deadline: .now() + 15)
            let task = Task {
                try await socket.open(path: "/recordings/test/1", offset: "0", etag: "test", bearer: "test")
            }
            task.cancel()
            _ = await task.result
            await socket.close()
            await socket.close()
        }
        let unopened = try LocalWiFiHTTP(ipv4: "127.0.0.1", port: 443, spkiSHA256: Data(repeating: 0, count: 32), deadline: .now() + 15)
        do { _ = try await unopened.read(maximumLength: 1); fatalError("Read before open accepted") }
        catch LocalWiFiTransportError.closed { }
        await unopened.close()
        print("Apple framing, DER SPKI, wrong-pin rejection and 100 cancellation/close checks passed")
    }
}
