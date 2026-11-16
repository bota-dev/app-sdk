import Foundation

public struct RecordingCaptureChannel: Codable, Sendable {
    public let sourceId: String
    public let role: String
    public init(sourceId: String, role: String) { self.sourceId = sourceId; self.role = role }
}
public struct RecordingCaptureGap: Codable, Sendable {
    public let offset: UInt32
    public let samples: UInt32
    public init(offset: UInt32, samples: UInt32) { self.offset = offset; self.samples = samples }
}
/// Describes original samples before resampling onto the recording's 48 kHz
/// clock. Missing frames are explicit gaps with zero container padding.
public struct RecordingCaptureMapping: Codable, Sendable {
    public let sourceClockId: String
    public let sourceEpoch: UInt32
    public let firstSample: UInt64
    public let samples: UInt32
    public let sampleRate: UInt32
    public let revision: UInt32
    public let discontinuity: Bool
    public let gaps: [RecordingCaptureGap]
    public init(sourceClockId: String, sourceEpoch: UInt32, firstSample: UInt64, samples: UInt32,
                sampleRate: UInt32, revision: UInt32, discontinuity: Bool, gaps: [RecordingCaptureGap] = []) {
        self.sourceClockId = sourceClockId; self.sourceEpoch = sourceEpoch; self.firstSample = firstSample
        self.samples = samples; self.sampleRate = sampleRate; self.revision = revision; self.discontinuity = discontinuity; self.gaps = gaps
    }
}
