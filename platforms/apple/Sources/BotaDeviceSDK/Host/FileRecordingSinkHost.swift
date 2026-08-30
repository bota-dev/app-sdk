import BotaDeviceSDKC
import Foundation

actor FileRecordingSinkHost: RecordingSinkHost {
    private let rootDirectory: URL
    private let fileManager: FileManager
    private var preparedSinks: Set<String> = []

    init(rootDirectory: URL, fileManager: FileManager = .default) {
        self.rootDirectory = rootDirectory
        self.fileManager = fileManager
    }

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        AsyncThrowingStream { continuation in
            do {
                let sinkID = try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_SINK_ID))
                let url = try sinkURL(sinkID)
                switch effect {
                case .recordingSinkTruncate:
                    let completed = try requiredUnsigned(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMPLETED_UNITS))
                    try truncate(url, to: completed)
                    preparedSinks.insert(sinkID)
                    continuation.yield(.init(kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_TRUNCATED)))
                case .recordingSinkAppend:
                    guard preparedSinks.contains(sinkID) else { throw NativeHostError.missingResource(sinkID) }
                    let payload = try requiredBytes(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD))
                    let durableUnits = try append(payload, to: url)
                    continuation.yield(.init(
                        kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_APPEND_COMPLETED),
                        fields: [.unsigned(
                            id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DURABLE_UNITS),
                            value: durableUnits
                        )]
                    ))
                case .recordingSinkFinalize:
                    guard preparedSinks.contains(sinkID) else { throw NativeHostError.missingResource(sinkID) }
                    let durableUnits = try fileSize(url)
                    if let expected = optionalUnsigned(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_EXPECTED_CRC32)),
                       UInt64(try crc32(url)) != expected {
                        continuation.yield(.init(
                            kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_INTEGRITY_FAILED)
                        ))
                    } else {
                        continuation.yield(.init(
                            kind: UInt32(BOTA_DEVICE_SDK_V1_HOST_EVENT_RECORDING_SINK_FINALIZED),
                            fields: [.unsigned(
                                id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_DURABLE_UNITS),
                                value: durableUnits
                            )]
                        ))
                    }
                case .recordingSinkDiscard:
                    try removeIfPresent(url)
                    preparedSinks.remove(sinkID)
                default:
                    throw NativeHostError.invalidEffect(effect.kind)
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
    }

    func fileURL(for sinkID: String) throws -> URL { try sinkURL(sinkID) }

    private func sinkURL(_ sinkID: String) throws -> URL {
        guard UUID(uuidString: sinkID) != nil else { throw NativeHostError.invalidOpaqueID(sinkID) }
        return rootDirectory.appendingPathComponent(sinkID).appendingPathExtension("recording")
    }

    private func truncate(_ url: URL, to completed: UInt64) throws {
        try fileManager.createDirectory(at: rootDirectory, withIntermediateDirectories: true)
        if !fileManager.fileExists(atPath: url.path) { fileManager.createFile(atPath: url.path, contents: nil) }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.truncate(atOffset: completed)
        try handle.synchronize()
    }

    private func append(_ data: Data, to url: URL) throws -> UInt64 {
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        try handle.synchronize()
        return try handle.offset()
    }

    private func fileSize(_ url: URL) throws -> UInt64 {
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        return UInt64(values.fileSize ?? 0)
    }

    private func crc32(_ url: URL) throws -> UInt32 {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var checksum: UInt32 = 0xFFFF_FFFF
        while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
            for byte in chunk {
                checksum ^= UInt32(byte)
                for _ in 0..<8 {
                    checksum = (checksum >> 1) ^ ((checksum & 1) == 1 ? 0xEDB8_8320 : 0)
                }
            }
        }
        return checksum ^ 0xFFFF_FFFF
    }

    private func removeIfPresent(_ url: URL) throws {
        if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
    }
}
