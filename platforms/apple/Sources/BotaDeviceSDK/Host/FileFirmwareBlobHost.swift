import BotaDeviceSDKC
import Foundation

actor FileFirmwareBlobHost: FirmwareBlobHost {
    private let maximumChunkLength: Int
    private var files: [UInt64: URL] = [:]

    init(maximumChunkLength: Int = Int(UInt16.max)) {
        self.maximumChunkLength = maximumChunkLength
    }

    func register(downloadID: UInt64, fileURL: URL) {
        files[downloadID] = fileURL
    }

    func unregister(downloadID: UInt64) {
        files[downloadID] = nil
    }

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        AsyncThrowingStream { continuation in
            do {
                guard case .firmwareBlobRead = effect else { throw NativeHostError.invalidEffect(effect.kind) }
                let downloadID = try requiredUnsigned(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID))
                let offset = try requiredUnsigned(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_OFFSET))
                let length = try requiredUnsigned(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_MAX_LENGTH))
                guard length > 0, length <= UInt64(maximumChunkLength) else {
                    throw NativeHostError.invalidChunkLength(length)
                }
                guard let fileURL = files[downloadID] else {
                    throw NativeHostError.missingResource(String(downloadID))
                }
                let handle = try FileHandle(forReadingFrom: fileURL)
                defer { try? handle.close() }
                try handle.seek(toOffset: offset)
                let data = try handle.read(upToCount: Int(length)) ?? Data()
                continuation.yield(.init(
                    kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_FIRMWARE_CHUNK_READ),
                    fields: [
                        .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DOWNLOAD_ID), value: downloadID),
                        .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_OFFSET), value: offset),
                        .bytes(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_VALUE), value: data),
                    ]
                ))
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
    }
}
