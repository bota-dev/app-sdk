import CryptoKit
import Foundation
@testable import BotaAppSDK

actor ByoFixture: ByoDeviceLink, ByoControlClient {
    let root: URL
    let bytes: Data
    let vector: [String: Any]?
    let assembled: Bool
    var nextSegment: [String: Any]?
    var lostPut = false; var failMerge = false; var needsRepair = false
    var calls: [String] = []
    var committed = false
    var loseCompletion = false
    var loseConfirm = false
    var removed = false
    init(root: URL, size: Int = 300, customer: Bool = false, assembled: Bool = false) {
        self.root = root; self.assembled = assembled
        vector = customer ? try! byoObject(Data(contentsOf: URL(fileURLWithPath: "protocol/vectors/byo-customer-hooks/package.json"))) : nil
        bytes = vector.map { Self.unhex($0["ciphertext_hex"] as! String) } ?? Data((0..<size).map { UInt8($0 % 256) })
    }
    static func unhex(_ value: String) -> Data { let chars = Array(value); return Data(stride(from: 0, to: chars.count, by: 2).map { UInt8(String(chars[$0...$0+1]), radix: 16)! }) }
    var hash: String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    var context: [String: Any] { vector?["context"] as? [String: Any] ?? ["contract_version": "bota-byo-batch-control-v1", "environment": "development",
        "organization_id": "org_test", "project_id": "proj_test", "configuration_id": "310eec75-feb0-487b-9d05-2d21c0b18794",
        "configuration_revision": 1, "destination_ref": "archive", "recording_id": "rec_test",
        "recording_uuid": "00112233-4455-6677-8899-aabbccddeeff", "recording_generation": 9, "device_id": "dev_test",
        "binding_generation": 1, "device_assignment_generation": 1, "upload_session_id": "cde68c61-db75-43c8-8112-623ad29a2f13",
        "owner_revision": 1, "policy_revision": "1", "channel": "ble", "file_profile": "botaenc2-batch",
        "ciphertext_length": bytes.count, "ciphertext_sha256": hash] }
    var status: [String: Any] {
        var value: [String: Any] = committed ? ["state": "completed", "receipt": ["opaque": "device-verified-receipt"]] : ["state": "receiving"]
        if vector != nil { value["hook_contract"] = "customer-hooks-v2"; value["package_profile"] = "bota-byo-package-v1" }
        if needsRepair { value["error"] = "upload_incomplete" }; return value
    }
    func control(_ suffix: String, body: Data?, context: Bool) async throws -> Data {
        calls.append("http:" + suffix)
        var reply: [String: Any]
        if suffix == "/capabilities" { reply = ["destination": ["kind": "customer"], "upload_modes": ["whole_file", "http_segments", "ws_relay"]] }
        else if suffix.isEmpty { reply = ["context": self.context] }
        else if suffix.hasSuffix("/prepare") || suffix.hasSuffix("/upload") {
            reply = ["authorization": vector?["authorization"] ?? ["configuration_sha256": String(repeating: "ab", count: 32)], "status": status]
            if !committed && suffix.hasSuffix("/upload") { nextSegment = try byoObject(body!)["segment"] as? [String: Any]; reply["upload"] = ["method": "PUT"] }
        } else if suffix.hasSuffix("/complete") {
            if let vector {
                let request = try byoObject(body!)
                var expected = vector["upload_package"] as! [String: Any]
                if assembled { expected["segment_count"] = 2 }
                let actual = try byoJSON(request["upload_package"] as! [String: Any]); let wanted = try byoJSON(expected); precondition(actual == wanted)
                if failMerge { failMerge = false; needsRepair = true; throw ByoFailure.http(409) }
            }
            committed = true
            if loseCompletion { loseCompletion = false; throw ByoFailure.disconnected }
            reply = status
        } else { reply = status }
        return try byoJSON(["data": reply])
    }
    func put(_ instructions: Data, file: URL) async throws {
        let saved = try Data(contentsOf: file)
        if let vector {
            let package = bytes + Self.unhex(vector["trailer_hex"] as! String)
            if let nextSegment {
                let offset = (nextSegment["offset"] as! NSNumber).intValue, length = (nextSegment["length"] as! NSNumber).intValue
                precondition(saved == package.subdata(in: offset..<offset+length))
            } else { precondition(saved == package) }
            if lostPut { lostPut = false; throw ByoFailure.http(403) }
        } else { precondition(saved == bytes) }
        calls.append("PUT")
    }
    func call(_ operation: UInt64, _ document: Data) async throws -> Data {
        calls.append("ble:\(operation)")
        switch operation {
        case 1: return try byoJSON(["contract": "bota-byo-device-batch-v1", "signing_key_ids": [1], "max_ciphertext_bytes": 134217728])
        case 2:
            if removed { return try byoJSON(["missing": true]) }
            return try byoJSON(["recording_uuid": context["recording_uuid"]!, "recording_generation": 9,
                "ciphertext_length": bytes.count, "ciphertext_sha256": hash])
        case 3: return try byoJSON(["manifest": vector?["manifest"] ?? ["opaque": "exact-original-manifest"]])
        case 4:
            let offset = document.prefix(8).enumerated().reduce(UInt64(0)) { $0 | UInt64($1.element) << ($1.offset * 8) }
            let size = Int(document[8]) | Int(document[9]) << 8
            return bytes.subdata(in: Int(offset)..<(Int(offset) + size))
        case 5: return Data(repeating: 0x42, count: 32)
        case 6:
            precondition(committed); removed = true
            if loseConfirm { loseConfirm = false; throw ByoFailure.disconnected }; return Data()
        default: fatalError("Unexpected operation")
        }
    }
    func contextData() throws -> Data { try byoJSON(context) }
    func failCompletion() { loseCompletion = true }
    func failConfirm() { loseConfirm = true }
    func failCustomerMerge() { failMerge = true; lostPut = true }
    func putCount() -> Int { calls.filter { $0 == "PUT" }.count }
    func run() async throws -> ByoUploadResult {
        let options = ByoStorageOptions(baseURL: URL(string: "https://app.example/v1")!, scopeKey: "account-a",
            organizationID: "org_test", projectID: "proj_test", deviceID: "dev_test", environment: "development",
            bindingGeneration: 1, stateDirectory: root, accessToken: { "app-token" }, validateScope: {})
        let session = try ByoUploadSession(options: options, recording: .init(uuid: "00112233-4455-6677-8899-aabbccddeeff", generation: 9),
            ble: self, http: self, refresh: {}, successor: assembled ? byoJSON(["context": context, "mode": "assembled"]) : nil)
        return try await session.run()
    }
}
actor ByoLiveFixture: ByoDeviceLink, ByoControlClient, ByoStreamSocket {
    let batch: ByoFixture
    let root: URL
    let initialFailure: Bool
    let establishedFailure: Bool
    let customer: Bool
    var closed = false; var selected = false; var saved = false; var handedOff = false
    var loseHandoff = false; var mode = ""; var offset = 0; var connections = 0; var sent = 0
    var segments: [Data] = []
    init(root: URL, initialFailure: Bool = false, establishedFailure: Bool = false, customer: Bool = false) {
        self.customer = customer
        self.root = root; batch = ByoFixture(root: root, size: 20000, customer: customer, assembled: customer)
        self.initialFailure = initialFailure; self.establishedFailure = establishedFailure
    }
    func contextData() async throws -> Data {
        var value = try byoObject(await batch.contextData()); value["upload_session_id"] = "11111111-1111-4111-8111-111111111111"
        return try byoJSON(value)
    }
    func call(_ operation: UInt64, _ document: Data) async throws -> Data {
        switch operation {
        case 1:
            var capability = try byoObject(await batch.call(1, document)); capability["upload_modes"] = ["whole_file", "http_segments", "ws_relay"]; return try byoJSON(capability)
        case 9:
            if document.count == 21 { selected = true }
            var facts: [String: Any] = ["recording_uuid": "00112233-4455-6677-8899-aabbccddeeff", "recording_generation": 9,
                "ciphertext_length": customer ? batch.bytes.count : (closed ? 20000 : 16384), "closed": closed || customer, "failed": false, "overflow": false,
                "retained_offset": offset, "stream_selected": selected, "ciphertext_sha256": await batch.hash]
            if saved { facts["stream_context"] = try byoObject(await contextData()) }; return try byoJSON(facts)
        case 10:
            precondition(selected && saved)
            let start = document[20..<24].enumerated().reduce(0) { $0 | Int($1.element) << ($1.offset * 8) }
            let size = Int(document[24]) | Int(document[25]) << 8
            return batch.bytes.subdata(in: start..<(start + size))
        case 11:
            offset = document[20..<24].enumerated().reduce(0) { $0 | Int($1.element) << ($1.offset * 8) }; return Data()
        case 12: precondition(selected); saved = true; return Data()
        case 13: precondition(handedOff); return Data()
        default: return try await batch.call(operation, document)
        }
    }
    func control(_ suffix: String, body: Data?, context: Bool) async throws -> Data { try await batch.control(suffix, body: body, context: context) }
    func put(_ instructions: Data, file: URL) async throws {
        let grant = try byoObject(instructions)
        if let start = grant["offset"] as? Int, let size = grant["length"] as? Int {
            let uploaded = try Data(contentsOf: file); precondition(uploaded == batch.bytes.subdata(in: start..<(start + size))); closed = true
        } else { try await batch.put(instructions, file: file) }
    }
    func statusData() async throws -> Data {
        var value: [String: Any] = ["phase": handedOff ? "handed_off" : "receiving", "recovery_required": false]
        if customer { value["hook_contract"] = "customer-hooks-v2"; value["package_profile"] = "bota-byo-package-v1"; value["contiguous_offset"] = offset }
        if handedOff { value["successor"] = try byoObject(await batch.contextData()); value["handoff_mode"] = mode }
        return try byoJSON(["data": value])
    }
    func streamControl(_ suffix: String, body: Data?) async throws -> Data {
        if suffix.isEmpty { precondition(selected); return try byoJSON(["data": ["context": byoObject(await contextData())]]) }
        if suffix.hasSuffix("/grants") || suffix.hasSuffix("/confirm") {
            let segment = try byoObject(body!)
            if customer && suffix.hasSuffix("/confirm") {
                return try byoJSON(["data": ["contract_version": "customer-hooks-v2", "result": ["state": "transferred", "segment": segment, "cleanup_allowed": false]]])
            }
            return try byoJSON(["data": ["result": ["state": suffix.hasSuffix("/grants") ? "write_authorized" : "confirmed", "segment": segment,
                "grant": ["offset": segment["offset"]!, "length": segment["length"]!]]]])
        }
        if suffix.hasSuffix("/handoff") {
            let input = try byoObject(body!); let requested = input["mode"] as! String
            if handedOff { precondition(requested == mode) }; mode = requested; handedOff = true
            if loseHandoff { loseHandoff = false; throw ByoFailure.disconnected }
        }
        return try await statusData()
    }
    func streamSocket(_ session: String) async throws -> any ByoStreamSocket {
        connections += 1; if initialFailure { throw ByoFailure.disconnected }; return self
    }
    func exchange(_ segment: Data, bytes: Data) async throws -> Data {
        precondition(!closed || sent > 0); closed = true; sent += 1; segments.append(bytes)
        if establishedFailure { throw ByoFailure.disconnected }
        if customer { let descriptor = try byoObject(segment)
            return try byoJSON(["type": "ack", "session_id": "11111111-1111-4111-8111-111111111111", "segment": descriptor,
                "proof": ["contract_version": "customer-hooks-v2", "result": ["state": "transferred", "segment": descriptor, "cleanup_allowed": false]]])
        }
        return Data()
    }
    func close() {}
    func failHandoff() { loseHandoff = true }
    func resumeTransferred() { selected = true; saved = true; offset = batch.bytes.count }
    func evidence() async -> (String, Int, Int, Int) { (mode, connections, offset, await batch.putCount()) }
    func run() async throws -> ByoUploadResult {
        let options = ByoStorageOptions(baseURL: URL(string: "https://app.example/v1")!, scopeKey: "account-a",
            organizationID: "org_test", projectID: "proj_test", deviceID: "dev_test", environment: "development",
            bindingGeneration: 1, stateDirectory: root, accessToken: { "app-token" }, validateScope: {})
        return try await ByoStreamSession(options: options, recording: .init(uuid: "00112233-4455-6677-8899-aabbccddeeff", generation: 9),
            ble: self, http: self, refresh: {}).run()
    }
}
@main struct ByoSmoke {
    static func main() async throws {
        for headers in [[:], ["Authorization": "Bearer upload-jwt"], ["content-type": "application/octet-stream"],
                        ["Content-Type": "application/octet-stream", "X-Upload-Token": "provider-token"]] {
            let request = try ByoHTTP.uploadRequest(byoJSON(["method": "PUT", "url": "https://uploads.example/part", "headers": headers]))
            precondition(request.httpMethod == "PUT")
            precondition(request.value(forHTTPHeaderField: "Content-Type") == "application/octet-stream")
            for (name, value) in headers { precondition(request.value(forHTTPHeaderField: name) == value) }
            precondition(request.allHTTPHeaderFields?.keys.filter { $0.lowercased() == "content-type" }.count == 1)
        }
        precondition(byoRetryDelay("5", fallback: 2) == 5)
        precondition(byoRetryDelay("Thu, 01 Jan 1970 00:00:05 GMT", fallback: 2, now: Date(timeIntervalSince1970: 0)) == 5)
        precondition(byoRetryDelay("3600", fallback: 2) == nil)
        let codec = ByoBLECodec(core: try CoreAbiClient())
        let wire = try codec.encode(opcode: 112, operation: 2, requestID: 7, offset: 0, total: 20,
            payload: Data(repeating: 0x42, count: 20), capacity: 244)
        let decoded = try codec.decode(wire)
        precondition(decoded.requestID == 7 && decoded.payload.count == 20)
        for op in 9...13 {
            let liveWire = try codec.encode(opcode: 112, operation: UInt64(op), requestID: 9, offset: 0, total: 20, payload: Data(repeating: 0x42, count: 20), capacity: 244)
            let livePacket = try codec.decode(liveWire); precondition(livePacket.operation == op)
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try ByoDurableStore(root: root)
        try store.save("state", Data([1, 2, 3])); let saved = try store.load("state"); precondition(saved == Data([1, 2, 3]))
        do { _ = try ByoDurableStore(root: root, synchronize: { _ in -1 }); fatalError("Flush failure accepted") }
        catch ByoFailure.persistence {}
        for scenario in 0..<3 {
            let fixture = ByoFixture(root: root.appendingPathComponent("case-\(scenario)"))
            if scenario == 1 { await fixture.failCompletion() }
            if scenario == 2 { await fixture.failConfirm() }
            if scenario > 0 {
                do { _ = try await fixture.run(); fatalError("Expected uncertain response") }
                catch ByoFailure.disconnected {}
            }
            let result = try await fixture.run(); precondition(result.recordingID == "rec_test")
            let puts = await fixture.putCount(); precondition(puts == 1)
        }
        for assembled in [false, true] {
            let fixture = ByoFixture(root: root.appendingPathComponent("customer-\(assembled)"), customer: true, assembled: assembled)
            if assembled { await fixture.failCustomerMerge() } else { await fixture.failCompletion() }
            do { _ = try await fixture.run(); fatalError("Expected uncertain customer completion") } catch {}
            let removed = await fixture.removed; precondition(!removed)
            _ = try await fixture.run()
            let puts = await fixture.putCount(); precondition(puts == (assembled ? 3 : 1))
        }
        let coordinator = DeviceOperationCoordinator(); let live = UUID(); let stop = UUID()
        try await coordinator.begin(live, operation: .transferRecording, allowRecordingControl: true)
        try await coordinator.begin(stop, operation: .encode, recordingControl: true)
        do { try await coordinator.begin(UUID(), operation: .encode); fatalError("Provisioning must remain exclusive") } catch {}
        await coordinator.end(live)
        do { try await coordinator.begin(UUID(), operation: .transferRecording); fatalError("Stop still owns the device") } catch {}
        await coordinator.end(stop)
        for scenario in 0..<4 {
            let live = ByoLiveFixture(root: root.appendingPathComponent("live-\(scenario)"), initialFailure: scenario == 1, establishedFailure: scenario == 2)
            if scenario == 3 {
                await live.failHandoff()
                do { _ = try await live.run(); fatalError("Expected uncertain handoff") } catch ByoFailure.disconnected {}
            }
            let result = try await live.run(); precondition(result.recordingID == "rec_test")
            let (mode, connections, offset, puts) = await live.evidence()
            precondition(mode == (scenario == 2 ? "whole_file" : "assembled"))
            precondition(connections == (scenario == 2 ? 4 : 1) && puts == (scenario == 2 ? 1 : 0))
            precondition(offset == (scenario == 2 ? 0 : 20000))
        }
        for httpOnly in [false, true] {
            let live = ByoLiveFixture(root: root.appendingPathComponent("customer-live-\(httpOnly)"), initialFailure: httpOnly, customer: true)
            _ = try await live.run()
            let (mode, _, offset, puts) = await live.evidence()
            precondition(mode == "assembled" && offset == 6645 && puts == 1)
        }
        let resumed = ByoLiveFixture(root: root.appendingPathComponent("customer-resumed"), customer: true)
        await resumed.resumeTransferred(); _ = try await resumed.run()
        let (resumedMode, _, resumedOffset, resumedPuts) = await resumed.evidence()
        precondition(resumedMode == "assembled" && resumedOffset == 6645 && resumedPuts == 1)
        print("PASS: customer packages, renewal, merge repair, transfer-only HTTP/WS ACK; Apple typed ABI, Batch recovery, live WS/HTTP, three reconnects, fenced handoff recovery and Stop concurrency")
    }
}
