import BotaDeviceSDKC
import Foundation

actor FileRecordingSinkHost: RecordingSinkHost {
    typealias StreamingUpload = @Sendable (StreamingUploadDestination, Data) async throws -> Void

    private let rootDirectory: URL
    private let fileManager: FileManager
    private let streamingUpload: StreamingUpload
    private var preparedSinks: Set<String> = []
    private var streamingSinks: [String: StreamingSinkSession] = [:]

    init(
        rootDirectory: URL,
        fileManager: FileManager = .default,
        streamingUpload: @escaping StreamingUpload = FileRecordingSinkHost.upload
    ) {
        self.rootDirectory = rootDirectory
        self.fileManager = fileManager
        self.streamingUpload = streamingUpload
    }

    func registerStreaming(
        sinkID: String,
        chunkSizeBytes: Int,
        flushIntervalMilliseconds: UInt64,
        destinationProvider: @escaping StreamingChunkDestinationProvider,
        finalize: @escaping StreamingFinalizeHandler
    ) throws {
        guard UUID(uuidString: sinkID) != nil else { throw NativeHostError.invalidOpaqueID(sinkID) }
        guard chunkSizeBytes > 0 else { throw NativeHostError.missingResource("streaming chunk size") }
        streamingSinks[sinkID] = StreamingSinkSession(
            chunkSizeBytes: chunkSizeBytes,
            flushIntervalMilliseconds: flushIntervalMilliseconds,
            destinationProvider: destinationProvider,
            finalize: finalize,
            upload: streamingUpload
        )
    }

    func unregisterStreaming(sinkID: String) async {
        if let session = streamingSinks.removeValue(forKey: sinkID) {
            await session.discard()
        }
    }

    func execute(_ effect: CoreEffect) async -> AsyncThrowingStream<CoreHostEventPayload, Error> {
        if effect.isStreamingEffect {
            do {
                let sinkID = try requiredText(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_SINK_ID))
                guard let session = streamingSinks[sinkID] else { throw NativeHostError.missingResource(sinkID) }
                let payload = try await session.execute(effect)
                return AsyncThrowingStream { continuation in
                    if let payload { continuation.yield(payload) }
                    continuation.finish()
                }
            } catch {
                return AsyncThrowingStream { $0.finish(throwing: error) }
            }
        }
        return AsyncThrowingStream<CoreHostEventPayload, Error> { continuation in
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

    private static func upload(destination: StreamingUploadDestination, body: Data) async throws {
        var request = URLRequest(url: destination.url)
        request.httpMethod = destination.method.rawValue
        request.setValue(destination.contentType, forHTTPHeaderField: "Content-Type")
        if let bearerToken = destination.bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        let (_, response) = try await URLSession.shared.upload(for: request, from: body)
        guard let http = response as? HTTPURLResponse,
              (200 ... 299).contains(http.statusCode)
        else { throw NativeHostError.httpStatus((response as? HTTPURLResponse)?.statusCode ?? 0) }
    }
}

private actor StreamingSinkSession {
    private let chunkSizeBytes: Int
    private let flushIntervalMilliseconds: UInt64
    private let destinationProvider: StreamingChunkDestinationProvider
    private let finalizeHandler: StreamingFinalizeHandler
    private let uploadHandler: FileRecordingSinkHost.StreamingUpload
    private let startedAtNanoseconds = DispatchTime.now().uptimeNanoseconds
    private var plaintextBuffer = Data()
    private var encryptedHeader: Data?
    private var encrypted: Bool?
    private var completedUnits: UInt64 = 0
    private var uploadedChunks: UInt32 = 0
    private var nextPlaintextSequence: UInt32 = 1
    private var flushTask: Task<Void, Never>?
    private var backgroundFailure: Error?
    private var discarded = false

    init(
        chunkSizeBytes: Int,
        flushIntervalMilliseconds: UInt64,
        destinationProvider: @escaping StreamingChunkDestinationProvider,
        finalize: @escaping StreamingFinalizeHandler,
        upload: @escaping FileRecordingSinkHost.StreamingUpload
    ) {
        self.chunkSizeBytes = chunkSizeBytes
        self.flushIntervalMilliseconds = flushIntervalMilliseconds
        self.destinationProvider = destinationProvider
        self.finalizeHandler = finalize
        self.uploadHandler = upload
    }

    func execute(_ effect: CoreEffect) async throws -> CoreHostEventPayload? {
        guard !discarded else { throw NativeHostError.missingResource("discarded streaming sink") }
        if let backgroundFailure { throw backgroundFailure }
        switch effect {
        case .streamingSinkAppendPlaintext:
            guard encrypted != true else { throw NativeHostError.invalidEffect(effect.kind) }
            encrypted = false
            let payload = try requiredBytes(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD))
            completedUnits += UInt64(payload.count)
            plaintextBuffer.append(payload)
            try await flushFullPlaintextChunks()
            schedulePartialFlush()
            return accepted()
        case .streamingSinkBeginEncrypted:
            guard encrypted != false else { throw NativeHostError.invalidEffect(effect.kind) }
            let key = try requiredBytes(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_EPHEMERAL_PUBLIC_KEY))
            let salt = try requiredBytes(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_SALT))
            guard key.count == 32, salt.count == 4 else { throw NativeHostError.invalidEffect(effect.kind) }
            encrypted = true
            encryptedHeader = key + salt
            return accepted()
        case .streamingSinkAppendEncrypted:
            guard encrypted == true, let encryptedHeader else { throw NativeHostError.invalidEffect(effect.kind) }
            let sequence = try requiredUnsigned(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_SEQUENCE))
            guard sequence <= UInt64(UInt32.max) else { throw NativeHostError.invalidEffect(effect.kind) }
            let payload = try requiredBytes(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_PAYLOAD))
            guard payload.count >= 16 else { throw NativeHostError.invalidEffect(effect.kind) }
            let request = StreamingChunkRequest(sequence: UInt32(sequence), isEncrypted: true)
            let body = sequence == 0 ? encryptedHeader + payload : payload
            do {
                try await uploadWithRetry(request: request, body: body)
                uploadedChunks += 1
            } catch where sequence > 0 {
                // The backend finalizer preserves the firmware sequence as an explicit audio gap.
            }
            completedUnits += UInt64(payload.count - 16)
            return accepted()
        case .streamingSinkFinalize:
            flushTask?.cancel()
            flushTask = nil
            if let backgroundFailure { throw backgroundFailure }
            let isEncrypted = try requiredBool(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_ENCRYPTED))
            let expectedChunks = try requiredUnsigned(effect, 125)
            let totalUnits = try requiredUnsigned(effect, UInt32(BOTA_DEVICE_SDK_V1_FIELD_TOTAL_UNITS))
            guard encrypted == isEncrypted, totalUnits == completedUnits,
                  expectedChunks <= UInt64(UInt32.max)
            else { throw NativeHostError.invalidEffect(effect.kind) }
            if !isEncrypted { try await flushPartialPlaintext() }
            let finalizedChunks = isEncrypted ? UInt32(expectedChunks) : uploadedChunks
            let milliseconds = (
                DispatchTime.now().uptimeNanoseconds &- startedAtNanoseconds
            ) / 1_000_000
            try await finalizeHandler(.init(
                totalChunks: finalizedChunks,
                durationMilliseconds: milliseconds,
                fileSizeBytes: completedUnits,
                isEncrypted: isEncrypted
            ))
            return .init(kind: 0x0229, fields: [
                .unsigned(id: 126, value: UInt64(uploadedChunks)),
                .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_TOTAL_UNITS), value: completedUnits),
            ])
        case .streamingSinkDiscard:
            discard()
            return nil
        default:
            throw NativeHostError.invalidEffect(effect.kind)
        }
    }

    func discard() {
        discarded = true
        flushTask?.cancel()
        flushTask = nil
        plaintextBuffer.removeAll(keepingCapacity: false)
        encryptedHeader = nil
    }

    private func accepted() -> CoreHostEventPayload {
        .init(kind: 0x0228, fields: [
            .unsigned(id: UInt32(BOTA_DEVICE_SDK_V1_FIELD_COMPLETED_UNITS), value: completedUnits),
        ])
    }

    private func flushFullPlaintextChunks() async throws {
        while plaintextBuffer.count >= chunkSizeBytes {
            let body = Data(plaintextBuffer.prefix(chunkSizeBytes))
            plaintextBuffer.removeFirst(chunkSizeBytes)
            try await uploadPlaintext(body)
        }
    }

    private func flushPartialPlaintext() async throws {
        guard !plaintextBuffer.isEmpty else { return }
        let body = plaintextBuffer
        plaintextBuffer.removeAll(keepingCapacity: true)
        try await uploadPlaintext(body)
    }

    private func uploadPlaintext(_ body: Data) async throws {
        let sequence = nextPlaintextSequence
        nextPlaintextSequence += 1
        try await uploadWithRetry(
            request: .init(sequence: sequence, isEncrypted: false),
            body: body
        )
        uploadedChunks += 1
    }

    private func uploadWithRetry(request: StreamingChunkRequest, body: Data) async throws {
        var lastError: Error?
        for attempt in 0..<3 {
            do {
                let destination = try await destinationProvider(request)
                try await uploadHandler(destination, body)
                return
            } catch {
                lastError = error
                if attempt < 2 {
                    try await Task.sleep(nanoseconds: UInt64(50 * (attempt + 1)) * 1_000_000)
                }
            }
        }
        throw lastError ?? NativeHostError.missingResource("streaming upload")
    }

    private func schedulePartialFlush() {
        flushTask?.cancel()
        guard flushIntervalMilliseconds > 0, !plaintextBuffer.isEmpty else { return }
        let delay = flushIntervalMilliseconds
        flushTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: delay * 1_000_000)
                try await self?.flushPartialPlaintext()
            } catch is CancellationError {
            } catch {
                await self?.recordBackgroundFailure(error)
            }
        }
    }

    private func recordBackgroundFailure(_ error: Error) {
        backgroundFailure = error
    }

    private func requiredBool(_ effect: CoreEffect, _ id: UInt32) throws -> Bool {
        for field in effect.packet.fields {
            if case let .bool(fieldID, value) = field, fieldID == id { return value }
        }
        throw NativeHostError.missingField(id)
    }
}

private extension CoreEffect {
    var isStreamingEffect: Bool {
        switch self {
        case .streamingSinkAppendPlaintext, .streamingSinkBeginEncrypted,
             .streamingSinkAppendEncrypted, .streamingSinkFinalize,
             .streamingSinkDiscard:
            true
        default:
            false
        }
    }
}
