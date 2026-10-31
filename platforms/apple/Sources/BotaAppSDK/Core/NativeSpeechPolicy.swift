import BotaDeviceSDKC
import Foundation

/// Owns only the native projection of the shared Rust policy. The speech media
/// coordinator must silence/cancel IO on any thrown error; this class owns no IO.
final class NativeSpeechPolicy: @unchecked Sendable {
    private let lock = NSLock()
    private var handle: OpaquePointer?

    init(configurationJSON: Data, grantJSON: Data, nowMs: UInt64) throws {
        var created: OpaquePointer?
        var error: OpaquePointer?
        let status = withSpeechBytes(configurationJSON) { configuration in
            withSpeechBytes(grantJSON) { grant in
                bota_device_sdk_v1_speech_new(configuration, grant, nowMs, &created, &error)
            }
        }
        defer { bota_device_sdk_v1_error_free(error) }
        guard status == BOTA_DEVICE_SDK_V1_OK, let created else {
            bota_device_sdk_v1_speech_free(created)
            throw speechError(status, error)
        }
        handle = created
    }

    func step(commandJSON: Data, nowMs: UInt64) throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        guard let handle else {
            throw CoreError(code: 14, operation: 5, retryable: false, protocolStatus: nil, detail: "speech policy is closed")
        }
        var output: OpaquePointer?
        var error: OpaquePointer?
        let status = withSpeechBytes(commandJSON) { command in
            bota_device_sdk_v1_speech_step(handle, command, nowMs, &output, &error)
        }
        defer {
            bota_device_sdk_v1_speech_output_free(output)
            bota_device_sdk_v1_error_free(error)
        }
        guard status == BOTA_DEVICE_SDK_V1_OK, let output else {
            closeLocked()
            throw speechError(status, error)
        }
        var view = BotaDeviceSdkSliceV1()
        guard bota_device_sdk_v1_speech_output_view(output, &view) == BOTA_DEVICE_SDK_V1_OK,
              view.len <= UInt64(Int.max), let data = view.data
        else {
            closeLocked()
            throw speechError(BOTA_DEVICE_SDK_V1_OPERATION_FAILED, nil)
        }
        // Copy before releasing the Rust output; no caption/grant history is retained.
        return Data(bytes: data, count: Int(view.len))
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        closeLocked()
    }

    private func closeLocked() {
        let old = handle
        handle = nil
        bota_device_sdk_v1_speech_free(old)
    }

    deinit { close() }
}

private func withSpeechBytes<T>(_ data: Data, _ body: (BotaDeviceSdkSliceV1) -> T) -> T {
    data.withUnsafeBytes { bytes in
        body(BotaDeviceSdkSliceV1(data: bytes.bindMemory(to: UInt8.self).baseAddress, len: UInt64(bytes.count)))
    }
}

private func speechError(_ status: BotaDeviceSdkStatusV1, _ owner: OpaquePointer?) -> CoreError {
    var view = BotaDeviceSdkErrorViewV1()
    if let owner, bota_device_sdk_v1_error_view(owner, &view) == BOTA_DEVICE_SDK_V1_OK {
        return CoreError(code: view.code, operation: view.operation, retryable: view.retryable != 0,
                         protocolStatus: view.has_protocol_status != 0 ? view.protocol_status : nil,
                         detail: "speech policy rejected the operation")
    }
    return CoreError(code: 21, operation: 13, retryable: false, protocolStatus: nil,
                     detail: "speech bridge failed with status \(status.rawValue)")
}
