import BotaDeviceSDKC
import Foundation

protocol EncryptedUploadV2Host: Sendable {
    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error>
}

struct EncryptedUploadV2HostFailure: Error, Equatable, Sendable {
    let errorCode: UInt32
    let retryable: Bool
    let protocolStatus: UInt16?
    let detail: String?

    init(errorCode: UInt32, retryable: Bool, protocolStatus: UInt16? = nil, detail: String? = nil) {
        self.errorCode = errorCode
        self.retryable = retryable
        self.protocolStatus = protocolStatus
        self.detail = detail
    }
}

struct UnavailableEncryptedUploadV2Host: EncryptedUploadV2Host {
    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        AsyncThrowingStream { continuation in
            continuation.finish(throwing: EncryptedUploadV2HostFailure(
                errorCode: UInt32(BOTA_DEVICE_SDK_V1_ERROR_FEATURE_UNAVAILABLE),
                retryable: false,
                detail: "encrypted upload v2 native host is not configured"
            ))
        }
    }
}
