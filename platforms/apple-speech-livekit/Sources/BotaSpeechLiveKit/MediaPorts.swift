import AVFAudio
import BotaAppSDK
import Foundation

/// An owned copy of native PCM, never transported through the shared policy ABI.
struct PCMFrame: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    var duration: Double { Double(buffer.frameLength) / buffer.format.sampleRate }
    static func copy(_ source: AVAudioPCMBuffer) throws -> Self {
        let format = source.format
        guard [8000.0, 16000, 24000, 32000, 44100, 48000].contains(format.sampleRate),
              (1...2).contains(format.channelCount), source.frameLength > 0,
              Double(source.frameLength) <= format.sampleRate / 10,
              [.pcmFormatInt16, .pcmFormatFloat32].contains(format.commonFormat),
              let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: source.frameLength) else {
            throw SpeechError.mediaFailed
        }
        copy.frameLength = source.frameLength
        let from = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: source.audioBufferList))
        let to = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        guard from.count == to.count else { throw SpeechError.mediaFailed }
        for (input, output) in zip(from, to) {
            guard let inputData = input.mData, let outputData = output.mData,
                  input.mDataByteSize >= output.mDataByteSize else { throw SpeechError.mediaFailed }
            outputData.copyMemory(from: inputData, byteCount: Int(output.mDataByteSize))
        }
        return Self(buffer: copy)
    }
}

protocol RTCInput: AnyObject, Sendable {
    var sid: String? { get }
    func dispose() async throws
}

struct RTCEvents: Sendable {
    let text: @Sendable (String, String) -> Void
    let frame: @Sendable (String, PCMFrame) -> Void
    let removed: @Sendable (String) -> Void
    let failed: @Sendable () -> Void
}

protocol RTCRoom: Sendable {
    func observe(_ events: RTCEvents?)
    func connect(_ grant: SpeechGrant) async throws
    func createInput() async throws -> any RTCInput
    func publish(_ input: any RTCInput) async throws
    func unpublish(_ input: any RTCInput) async throws
    func capture(_ enabled: Bool) throws
    func subscribe(_ sids: Set<String>) throws
    func disconnect() async
    func release() async throws
}

protocol PCMOutput: AnyObject, Sendable {
    func silence() throws
    func select(_ sids: Set<String>) throws
    func frame(_ sid: String, _ frame: PCMFrame)
    func clear() async throws
    func drain(_ sid: String) async throws
    func close() async throws
}

/// These tasks own native work independently of cancellation of a public waiter.
final class MediaTasks: @unchecked Sendable {
    private let lock = NSLock()
    private var tasks: [UUID: Task<Void, any Error>] = [:]
    private var tail: Task<Void, any Error>?
    private var closed = false

    func submit(serial: Bool = false, _ body: @escaping @Sendable () async throws -> Void) throws -> Task<Void, any Error> {
        let id = UUID()
        let task = try lock.withLock {
            guard !closed else { throw SpeechError.closed }
            let previous = serial ? tail : nil
            let task = Task {
                if let previous { _ = await previous.result }
                try await body()
            }
            tasks[id] = task
            if serial { tail = task }
            return task
        }
        Task { _ = await task.result; self.lock.withLock { self.tasks[id] = nil } }
        return task
    }

    func retire() -> [Task<Void, any Error>] {
        lock.withLock { closed = true; return Array(tasks.values) }
    }
}
