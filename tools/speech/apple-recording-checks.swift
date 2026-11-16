import Foundation
@main struct RecordingSpeechHostChecks {
    static func main() async throws {
        try await RecordingSpeechTests().testDirectNativeOwnerUsesRustFramesAndJoinsTransportWithoutOwningCapture()
        print("PASS direct recording transport, frames and immediate playback retirement")
    }
}
