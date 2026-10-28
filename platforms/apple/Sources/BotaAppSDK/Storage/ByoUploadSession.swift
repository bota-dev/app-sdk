import CryptoKit
import Foundation

/// The device verifies independent signed documents and durably owns cleanup.
/// This native adapter retains opaque HTTP material; Rust arbitrates workflow.
actor ByoUploadSession {
    private let options: ByoStorageOptions
    private let recording: ByoRecording
    private let ble: any ByoDeviceLink
    private let http: any ByoControlClient
    private let refresh: @Sendable () async throws -> Void
    private let store: ByoDurableStore
    private let recovery: ByoRecoveryHost
    private var documents: [String: Any]
    private var fields: [CoreField] = []
    private var phase: UInt64 = 0

    init(options: ByoStorageOptions, recording: ByoRecording, ble: any ByoDeviceLink, http: any ByoControlClient,
         refresh: @escaping @Sendable () async throws -> Void, successor: Data? = nil) throws {
        guard let uuid = UUID(uuidString: recording.uuid), uuid.uuidString.lowercased() == recording.uuid else { throw ByoFailure.invalidConfiguration }
        self.options = options; self.recording = recording; self.ble = ble; self.http = http; self.refresh = refresh
        let identity = try byoJSON(["scope": options.scopeKey, "organization": options.organizationID,
            "project": options.projectID, "device": options.deviceID, "binding": options.bindingGeneration,
            "environment": options.environment, "origin": options.baseURL.absoluteString,
            "recording": recording.uuid, "generation": recording.generation])
        let key = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
        let store = try ByoDurableStore(root: options.stateDirectory.appendingPathComponent(key, isDirectory: true))
        self.store = store
        documents = try store.load("documents").map(byoObject) ?? [:]
        if let saved = documents["identity"] as? String, saved != identity.base64EncodedString() { throw ByoFailure.identityConflict }
        documents["identity"] = identity.base64EncodedString()
        if let successor {
            let seed = try byoObject(successor)
            guard let context = seed["context"] as? [String: Any], let mode = seed["mode"] as? String,
                  ["assembled", "whole_file"].contains(mode) else { throw ByoFailure.protocolViolation }
            if let old = documents["context"] as? [String: Any], try byoJSON(old) != byoJSON(context) { throw ByoFailure.identityConflict }
            documents["context"] = context; documents["assembled"] = mode == "assembled"
            try store.save("documents", byoJSON(documents))
        }
        recovery = ByoRecoveryHost(core: try CoreAbiClient(), load: { try store.load("state") }, save: { try store.save("state", $0) })
    }
    private func persist() throws { try store.save("documents", byoJSON(documents)) }
    private func advance(_ command: UInt64, _ extra: [CoreField] = []) throws -> ByoRecoveryHost.Decision {
        let value = try recovery.advance(fields: fields + [.unsigned(id: 97, value: command)] + extra)
        phase = value.phase; return value
    }
    private func text(_ object: [String: Any], _ key: String) throws -> String {
        guard let value = object[key] as? String, !value.isEmpty else { throw ByoFailure.protocolViolation }; return value
    }
    private func number(_ object: [String: Any], _ key: String) throws -> UInt64 {
        guard let value = object[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue >= 0, value.doubleValue <= 9007199254740991,
              Double(value.uint64Value) == value.doubleValue else { throw ByoFailure.protocolViolation }; return value.uint64Value
    }
    private func scope(_ context: [String: Any]) throws {
        guard try text(context, "organization_id") == options.organizationID,
              try text(context, "project_id") == options.projectID, try text(context, "device_id") == options.deviceID,
              try text(context, "environment") == options.environment, try number(context, "binding_generation") == options.bindingGeneration,
              try text(context, "recording_uuid") == recording.uuid, try number(context, "recording_generation") == recording.generation,
              try text(context, "channel") == "ble" else { throw ByoFailure.identityConflict }
        fields = [.unsigned(id: 205, value: UInt64(["development", "gamma", "production"].firstIndex(of: options.environment)!)),
            .text(id: 206, value: options.organizationID), .text(id: 207, value: options.projectID),
            .text(id: 208, value: options.deviceID), .unsigned(id: 209, value: UInt64(options.bindingGeneration)),
            .unsigned(id: 210, value: try number(context, "device_assignment_generation")),
            .text(id: 211, value: try text(context, "policy_revision")), .text(id: 13, value: recording.uuid),
            .unsigned(id: 129, value: UInt64(recording.generation))]
    }
    private func path(_ context: [String: Any]) throws -> String {
        let id = try text(context, "upload_session_id")
        guard UUID(uuidString: id) != nil, id == id.lowercased() else { throw ByoFailure.protocolViolation }; return "/" + id
    }
    private func rpc(_ operation: UInt64, _ body: Data = Data()) async throws -> Data {
        do { return try await ble.call(operation, body) }
        catch ByoFailure.contextExpired { try await refresh(); return try await ble.call(operation, body) }
    }
    private func renew(_ endpoint: String) async throws {
        let request = try recovery.prepareRenewal(scopeFields: fields, operationId: UUID().uuidString.lowercased())
        let reply = try byoDataObject(await http.control(endpoint + "/recover", body: byoJSON([
            "operation_id": request.operationId, "expected_revision": request.expectedRevision])))
        guard try text(reply, "operation_id") == request.operationId else { throw ByoFailure.identityConflict }
        let revision = try number(reply, "revision")
        documents["renewal"] = reply; try persist()
        try recovery.acceptRenewal(scopeFields: fields, request: request, revision: revision)
    }
    func run() async throws -> ByoUploadResult {
        try Task.checkCancellation(); try await options.validateScope(); try await refresh()
        var capabilities = try byoObject(await rpc(1))
        capabilities["customer_hooks"] = "customer-hooks-v2"
        capabilities["max_ciphertext_bytes"] = min((capabilities["max_ciphertext_bytes"] as? NSNumber)?.uint64Value ?? 134201332, 134201332)
        capabilities["upload_modes"] = ["whole_file"]; capabilities["durable_source"] = true; capabilities["durable_receipt"] = true
        let selection = try byoDataObject(await http.control("/capabilities", body: byoJSON(capabilities)))
        if documents["context"] == nil && documents["selected_customer"] as? Bool != true {
            guard (selection["destination"] as? [String: Any])?["kind"] as? String == "customer" else { throw ByoFailure.notSelected }
        }
        documents["selected_customer"] = true; try persist()
        if let saved = documents["context"] as? [String: Any], try store.load("state") != nil {
            try scope(saved); _ = try advance(2)
            if phase == 9 { try store.removeCiphertext(); return try result(saved) }
        }
        var uuid = UUID(uuidString: recording.uuid)!.uuid
        var identity = withUnsafeBytes(of: &uuid) { Data($0) }
        var generation = recording.generation.littleEndian
        identity.append(withUnsafeBytes(of: &generation) { Data($0) })
        identity.append(1) // Durable device selection precedes backend CREATE.
        let facts = try byoObject(await rpc(2, identity))
        if facts["missing"] as? Bool == true {
            guard phase == 8, let saved = documents["context"] as? [String: Any],
                  let prior = documents["receipt"] as? [String: Any] else { throw ByoFailure.identityConflict }
            let status = try byoDataObject(await http.control(path(saved)))
            guard let receipt = status["receipt"] as? [String: Any], try byoJSON(prior) == byoJSON(receipt),
                  try advance(15).mayCleanup else { throw ByoFailure.identityConflict }
            _ = try advance(12); try store.removeCiphertext(); return try result(saved)
        }
        guard try text(facts, "recording_uuid") == recording.uuid,
              try number(facts, "recording_generation") == recording.generation else { throw ByoFailure.identityConflict }
        let length = try number(facts, "ciphertext_length"), hash = try text(facts, "ciphertext_sha256")
        guard (293...134217728).contains(length), hash.count == 64 else { throw ByoFailure.protocolViolation }
        var context: [String: Any]
        if let saved = documents["context"] as? [String: Any] { context = saved }
        else {
            var input = facts; input["channel"] = "ble"
            let created = try byoDataObject(await http.control("", body: byoJSON(input)))
            guard let value = created["context"] as? [String: Any] else { throw ByoFailure.protocolViolation }
            context = value; try scope(context); documents["context"] = value; try persist()
        }
        try scope(context)
        guard try number(context, "ciphertext_length") == length, try text(context, "ciphertext_sha256") == hash else { throw ByoFailure.identityConflict }
        if try store.load("state") == nil { _ = try advance(1) } else { _ = try advance(2) }
        if phase == 9 { try store.removeCiphertext(); return try result(context) }
        _ = try advance(6, [.unsigned(id: 130, value: length), .text(id: 144, value: hash)])
        let endpoint = try path(context)
        let inspection = try advance(15)
        if inspection.renewalOperation != nil { try await renew(endpoint) }
        var upload = try byoDataObject(await http.control(endpoint + "/prepare", body: byoJSON([:])))
        guard let authorization = upload["authorization"] as? [String: Any],
              var status = upload["status"] as? [String: Any] else { throw ByoFailure.protocolViolation }
        let customer = status["hook_contract"] as? String == "customer-hooks-v2"
        guard !customer || status["package_profile"] as? String == "bota-byo-package-v1" else { throw ByoFailure.protocolViolation }
        if let old = documents["customer_package"] as? Bool, old != customer { throw ByoFailure.identityConflict }
        documents["customer_package"] = customer
        if let old = documents["authorization"] as? [String: Any], try byoJSON(old) != byoJSON(authorization) { throw ByoFailure.identityConflict }
        documents["authorization"] = authorization; try persist()
        if phase == 0 {
            _ = try advance(3, [.text(id: 212, value: try text(context, "recording_id")),
                .text(id: 213, value: try text(context, "configuration_id")),
                .unsigned(id: 214, value: try number(context, "configuration_revision")),
                .text(id: 215, value: try text(authorization, "configuration_sha256")),
                .text(id: 216, value: try text(context, "destination_ref")),
                .text(id: 217, value: try text(context, "upload_session_id")),
                .unsigned(id: 165, value: try number(context, "owner_revision")), .unsigned(id: 218, value: 3)])
        }
        do { upload = try byoDataObject(await http.control(endpoint + "/upload", body: byoJSON([:]))) }
        catch ByoFailure.expiredAuthorization {
            try await renew(endpoint)
            upload = try byoDataObject(await http.control(endpoint + "/upload", body: byoJSON([:])))
        }
        guard let latest = upload["status"] as? [String: Any] else { throw ByoFailure.protocolViolation }
        status = latest
        func bundle(_ status: [String: Any], _ upload: [String: Any]) -> [String: Any] {
            var body: [String: Any] = ["context": context, "authorization": authorization]
            if let receipt = status["receipt"] as? [String: Any] {
                body["receipt"] = receipt
                if let recovery = (status["recovery"] as? [String: Any])?["permit"] as? [String: Any] { body["recovery"] = recovery }
            } else if let recovery = upload["recovery"] as? [String: Any] { body["recovery"] = recovery }
            return body
        }
        try await refresh()
        var opened: [String: Any]
        do { opened = try byoObject(await rpc(3, byoJSON(bundle(status, upload)))) }
        catch ByoFailure.deviceRejected {
            // A renewal is still constrained by the server; rejection never permits fallback or cleanup.
            try await renew(endpoint)
            upload = try byoDataObject(await http.control(endpoint + "/upload", body: byoJSON([:])))
            guard let next = upload["status"] as? [String: Any] else { throw ByoFailure.protocolViolation }; status = next
            try await refresh(); opened = try byoObject(await rpc(3, byoJSON(bundle(status, upload))))
        }
        guard let manifest = opened["manifest"] as? [String: Any] else { throw ByoFailure.protocolViolation }
        if let previous = documents["manifest"] as? [String: Any], try byoJSON(previous) != byoJSON(manifest) { throw ByoFailure.identityConflict }
        documents["manifest"] = manifest; try persist()
        if customer && status["receipt"] is [String: Any] == false {
            try await package(length: length, hash: hash, context: context, authorization: authorization, manifest: manifest)
            if ["upload_incomplete", "upload_not_found"].contains(status["error"] as? String ?? "") {
                documents["package_next"] = 0; documents["package_sent"] = false; try persist()
            }
            if documents["package_sent"] as? Bool != true {
                try await sendPackage(endpoint: endpoint, length: length)
            }
            if phase == 5 { _ = try advance(9) }
        } else if status["receipt"] is [String: Any] == false && phase == 5 {
            if documents["assembled"] as? Bool == true { _ = try advance(9) }
            else if let instructions = upload["upload"] as? [String: Any] {
                try await download(length: length, hash: hash)
                try await http.put(byoJSON(instructions), file: store.root.appendingPathComponent("ciphertext"))
                _ = try advance(9)
            } else {
                // The server may already own the exact manifest after an uncertain complete response.
                guard documents["manifest"] != nil else { throw ByoFailure.pending }
                _ = try advance(9)
            }
        } else if phase == 5 { _ = try advance(9) }
        if status["receipt"] is [String: Any] == false {
            for poll in 0..<24 {
                try Task.checkCancellation()
                status = try byoDataObject(await http.control(endpoint + "/complete", body: byoJSON(customer ? ["manifest": manifest, "upload_package": documents["upload_package"]!] : ["manifest": manifest])))
                if status["receipt"] is [String: Any] { break }
                guard !["failed", "blocked"].contains(status["state"] as? String ?? "") else { throw ByoFailure.deviceRejected }
                if poll < 23 { try await Task.sleep(nanoseconds: 5_000_000_000) }
            }
        }
        guard let receipt = status["receipt"] as? [String: Any] else { throw ByoFailure.pending }
        documents["receipt"] = receipt; try persist(); try await refresh()
        var receiptBundle: [String: Any] = ["receipt": receipt]
        if let permit = (status["recovery"] as? [String: Any])?["permit"] as? [String: Any] { receiptBundle["recovery"] = permit }
        let digest = try await rpc(5, byoJSON(receiptBundle))
        guard digest.count == 32 else { throw ByoFailure.protocolViolation }
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        if let prior = documents["receipt_sha256"] as? String, prior != hex { throw ByoFailure.identityConflict }
        documents["receipt_sha256"] = hex; try persist()
        if phase == 6 { _ = try advance(10, [.text(id: 162, value: hex)]) }
        if phase == 7 { _ = try advance(11, [.text(id: 162, value: hex)]) }
        guard try advance(15).mayCleanup else { throw ByoFailure.protocolViolation }
        _ = try await rpc(6, digest)
        _ = try advance(12); try store.removeCiphertext()
        return try result(context)
    }
    private func result(_ context: [String: Any]) throws -> ByoUploadResult {
        ByoUploadResult(recordingID: try text(context, "recording_id"), uploadSessionID: try text(context, "upload_session_id"))
    }
    private func package(length: UInt64, hash: String, context: [String: Any], authorization: [String: Any], manifest: [String: Any]) async throws {
        let trailer = try byoCustomer(1, ["context": context, "authorization": authorization, "manifest": manifest])
        let encoded = trailer.base64EncodedString()
        if let old = documents["package_trailer"] as? String, old != encoded { throw ByoFailure.identityConflict }
        documents["package_trailer"] = encoded; try persist()
        // Rebuild from the retained device source after a crash; never reseal the key.
        try await download(length: length, hash: hash, trailer: trailer)
        let file = try FileHandle(forReadingFrom: store.root.appendingPathComponent("ciphertext")); defer { try? file.close() }
        var digest = SHA256(); var count: UInt64 = 0
        while let bytes = try file.read(upToCount: 65536), !bytes.isEmpty { digest.update(data: bytes); count += UInt64(bytes.count) }
        guard count == length + UInt64(trailer.count) else { throw ByoFailure.persistence }
        var facts: [String: Any] = ["file_size_bytes": count, "content_sha256": digest.finalize().map { String(format: "%02x", $0) }.joined(),
            "metadata_sha256": SHA256.hash(data: trailer).map { String(format: "%02x", $0) }.joined()]
        if documents["assembled"] as? Bool == true { facts["segment_count"] = (length + 16383) / 16384 + 1 }
        if let old = documents["upload_package"] as? [String: Any], try byoJSON(old) != byoJSON(facts) { throw ByoFailure.identityConflict }
        documents["upload_package"] = facts; try persist()
    }
    private func sendPackage(endpoint: String, length: UInt64) async throws {
        let assembled = documents["assembled"] as? Bool == true
        let bodyCount = (length + 16383) / 16384
        guard !assembled || bodyCount < 8192 else { throw ByoFailure.protocolViolation }
        let total = try number(documents["upload_package"] as! [String: Any], "file_size_bytes")
        var next = (documents["package_next"] as? NSNumber)?.uint64Value ?? (assembled ? bodyCount : 0)
        guard next <= (assembled ? bodyCount + 1 : 0) else { throw ByoFailure.identityConflict }
        let source = try FileHandle(forReadingFrom: store.root.appendingPathComponent("ciphertext")); defer { try? source.close() }
        while !assembled || next <= bodyCount {
            try Task.checkCancellation()
            var request: [String: Any] = [:]
            var target = store.root.appendingPathComponent("ciphertext")
            if assembled {
                let offset = next == bodyCount ? length : next * 16384
                let count = next == bodyCount ? total - length : min(16384, length - offset)
                try source.seek(toOffset: offset)
                guard let bytes = try source.read(upToCount: Int(count)), bytes.count == count else { throw ByoFailure.persistence }
                request["segment"] = ["index": next, "offset": offset, "length": count, "sha256": SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()]
                let file = try store.createCiphertext("segment")
                do { try file.write(contentsOf: bytes); try file.synchronize(); try file.close() } catch { try? file.close(); throw error }
                target = store.root.appendingPathComponent("segment")
            }
            for attempt in 0..<3 {
                var reply: [String: Any]
                do { reply = try byoDataObject(await http.control(endpoint + "/upload", body: byoJSON(request))) }
                catch ByoFailure.expiredAuthorization { try await renew(endpoint); reply = try byoDataObject(await http.control(endpoint + "/upload", body: byoJSON(request))) }
                guard let grant = reply["upload"] as? [String: Any] else { throw ByoFailure.pending }
                do { try await http.put(byoJSON(grant), file: target); break }
                catch { if attempt == 2 { throw error }; try Task.checkCancellation() }
            }
            if !assembled { break }
            next += 1; documents["package_next"] = next; try persist()
        }
        documents["package_sent"] = true; try persist()
    }
    private func download(length: UInt64, hash: String, trailer: Data = Data()) async throws {
        let file = try store.createCiphertext(); defer { try? file.close() }
        var digest = SHA256(); var offset: UInt64 = 0
        var refreshed = ByoContinuousInstant.now
        while offset < length {
            if refreshed.seconds(to: .now) > 30 { try await refresh(); refreshed = .now }
            let count = UInt16(min(4096, length - offset))
            var position = offset.littleEndian; var size = count.littleEndian
            var request = withUnsafeBytes(of: &position) { Data($0) }
            request.append(withUnsafeBytes(of: &size) { Data($0) })
            let data = try await rpc(4, request)
            guard data.count == Int(count) else { throw ByoFailure.protocolViolation }
            try file.write(contentsOf: data); digest.update(data: data); offset += UInt64(count)
        }
        guard digest.finalize().map({ String(format: "%02x", $0) }).joined() == hash else { throw ByoFailure.identityConflict }
        try file.write(contentsOf: trailer)
        try file.synchronize()
    }
}
