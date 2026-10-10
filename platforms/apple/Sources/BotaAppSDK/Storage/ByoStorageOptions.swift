import Foundation

public struct ByoStorageOptions: Sendable {
    public let baseURL: URL
    public let scopeKey, organizationID, projectID, deviceID, environment: String
    public let bindingGeneration: UInt32
    public let stateDirectory: URL
    public let accessToken: @Sendable () async throws -> String
    /// Must reject after account/project/binding changes. Called before every I/O.
    public let validateScope: @Sendable () async throws -> Void
    public init(baseURL: URL, scopeKey: String, organizationID: String, projectID: String,
                deviceID: String, environment: String, bindingGeneration: UInt32, stateDirectory: URL,
                accessToken: @escaping @Sendable () async throws -> String,
                validateScope: @escaping @Sendable () async throws -> Void) {
        self.baseURL = baseURL; self.scopeKey = scopeKey; self.organizationID = organizationID
        self.projectID = projectID; self.deviceID = deviceID; self.environment = environment
        self.bindingGeneration = bindingGeneration; self.stateDirectory = stateDirectory
        self.accessToken = accessToken; self.validateScope = validateScope
    }
}
public struct ByoRecording: Sendable, Equatable {
    public let uuid: String
    public let generation: UInt32
    public init(uuid: String, generation: UInt32) { self.uuid = uuid; self.generation = generation }
}
public struct ByoUploadResult: Sendable, Equatable {
    public let recordingID, uploadSessionID: String
}

public struct ByoStorageError: Error, LocalizedError, CustomNSError, Sendable {
    public let code: String
    public let retryable: Bool
    public let httpStatus: Int?
    public var errorDescription: String? { "BOTA_BYO_" + code.uppercased() }
    public static var errorDomain: String { "dev.bota.sdk.byo" }
    public var errorCode: Int { httpStatus ?? (retryable ? 1 : 2) }
    public var errorUserInfo: [String: Any] {
        [NSLocalizedDescriptionKey: errorDescription!, "byoCode": errorDescription!, "retryable": retryable]
    }
    static func safe(_ error: Error) -> Error {
        if error is CancellationError { return error }
        if let error = error as? ByoStorageError { return error }
        let code: String; let retry: Bool; var status: Int?
        switch error {
        case ByoFailure.pending: code = "pending"; retry = true
        case ByoFailure.timeout, ByoFailure.disconnected: code = "transport"; retry = true
        case ByoFailure.contextExpired: code = "context_expired"; retry = true
        case ByoFailure.notSelected: code = "not_selected"; retry = false
        case ByoFailure.persistence: code = "persistence"; retry = false
        case ByoFailure.identityConflict: code = "identity_conflict"; retry = false
        case ByoFailure.deviceRejected: code = "device_rejected"; retry = false
        case ByoFailure.invalidConfiguration: code = "invalid_configuration"; retry = false
        case ByoFailure.expiredAuthorization: code = "expired"; retry = false; status = 409
        case ByoFailure.http(let value): code = "http_\(value)"; retry = [425, 429].contains(value) || value >= 500; status = value
        case is URLError: code = "transport"; retry = true
        default: code = "protocol_violation"; retry = false
        }
        return ByoStorageError(code: code, retryable: retry, httpStatus: status)
    }
}
