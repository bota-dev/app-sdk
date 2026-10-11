import BotaAppSDK
import Foundation

/// Metadata-only RN boundary. SDK native code owns documents and recording bytes.
@MainActor final class ByoBridgeDriver {
    private let credentials: UploadCredentials
    private var tasks: [String: Task<String, Error>] = [:]
    private var cancelled: Set<String> = []
    private var stopped = false
    init(credentials: UploadCredentials) { self.credentials = credentials }
    private struct Input: Decodable {
        let operationId: String
        let device: Device
        let recording: Recording?
        let mode: String
        let scope: Scope
        struct Recording: Decodable { let uuid: String; let generation: UInt32 }
        struct Scope: Decodable {
            let baseUrl, scopeKey, organizationId, projectId, environment, deviceId: String
            let bindingGeneration: UInt32
        }
        struct Device: Decodable {
            let id, serialNumber, deviceType, firmwareVersion, connectionState: String
            let hardwareRevision: String?
            let isProvisioned: Bool
            let mtu: Int
            func native() throws -> ConnectedDevice {
                let type: DeviceType
                switch deviceType {
                case "bota_pin": type = .botaPin
                case "bota_pin_4g": type = .botaPin4G
                case "bota_note": type = .botaNote
                default: throw UploadFailure.invalidInput
                }
                guard connectionState == "connected", (23...517).contains(mtu),
                      !id.isEmpty, !serialNumber.isEmpty else { throw UploadFailure.invalidInput }
                return ConnectedDevice(id: id, serialNumber: serialNumber, deviceType: type, firmwareVersion: firmwareVersion,
                    hardwareRevision: hardwareRevision, isProvisioned: isProvisioned, connectionState: .connected, mtu: mtu)
            }
        }
    }
    private func check(_ id: String) throws {
        try Task.checkCancellation()
        guard !stopped, !cancelled.contains(id), tasks[id] != nil else { throw UploadFailure.cancelled }
    }
    func sync(_ json: String) async throws -> String {
        guard json.utf8.count <= 8192 else { throw UploadFailure.invalidInput }
        let input = try JSONDecoder().decode(Input.self, from: Data(json.utf8))
        let id = input.operationId
        guard id.hasPrefix("byo-"), id.utf8.count <= 64, !stopped, !cancelled.contains(id), tasks[id] == nil,
              let url = URL(string: input.scope.baseUrl) else { throw UploadFailure.invalidInput }
        let device = try input.device.native()
        let task = Task {
            try self.check(id)
            let options = ByoStorageOptions(baseURL: url, scopeKey: input.scope.scopeKey,
                organizationID: input.scope.organizationId, projectID: input.scope.projectId, deviceID: input.scope.deviceId,
                environment: input.scope.environment, bindingGeneration: input.scope.bindingGeneration,
                stateDirectory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("BotaSDKByo", isDirectory: true),
                accessToken: { try await self.credentials.request(operationId: id) },
                validateScope: { try await self.check(id) })
            let bytes: Data
            if input.mode == "list" {
                let recordings = try await BotaDeviceClient.shared.recordings.listByoRecordings(device, options: options)
                try self.check(id)
                bytes = try JSONSerialization.data(withJSONObject: recordings.map { ["uuid": $0.uuid, "generation": $0.generation] as [String: Any] })
            } else {
                guard input.mode == "stream" || (input.mode == "sync" && input.recording != nil) else { throw UploadFailure.invalidInput }
                let selected = input.recording.map { ByoRecording(uuid: $0.uuid, generation: $0.generation) }
                let result: ByoUploadResult
                if input.mode == "stream" { result = try await BotaDeviceClient.shared.recordings.streamByoRecording(device, recording: selected, options: options) }
                else { result = try await BotaDeviceClient.shared.recordings.syncByoRecording(device, recording: selected!, options: options) }
                try self.check(id)
                bytes = try JSONSerialization.data(withJSONObject: ["recordingId": result.recordingID, "uploadSessionId": result.uploadSessionID])
            }
            return String(decoding: bytes, as: UTF8.self)
        }
        tasks[id] = task
        defer { tasks[id] = nil; cancelled.remove(id); credentials.cancel(operationId: id) }
        return try await task.value
    }
    func cancel(_ id: String) async {
        guard id.hasPrefix("byo-"), id.utf8.count <= 64 else { return }
        if cancelled.count >= 128 { stopped = true }
        else { cancelled.insert(id) }
        let task = tasks[id]; task?.cancel(); credentials.cancel(operationId: id); _ = await task?.result
    }
    func stop() async {
        stopped = true
        let current = tasks
        for (id, task) in current { task.cancel(); credentials.cancel(operationId: id) }
        for task in current.values { _ = await task.result }
    }
}
