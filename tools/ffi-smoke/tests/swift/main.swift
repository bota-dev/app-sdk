import Foundation

let capabilities = UInt64(3)
let command =
    #"{"DiscoverDevices":{"timeout_ms":5000,"allow_duplicates":true}}"#
let cancellationHigh = UInt64(0x0102_0304_0506_0708)
let cancellationLow = UInt64(0x1112_1314_1516_1718)
let engine = UniFfiEngine()

do {
    try engine.startJson(
        commandJson: command,
        capabilityBits: capabilities,
        cancellationIdHigh: cancellationHigh,
        cancellationIdLow: cancellationLow)
    guard engine.pollOutput() != nil else {
        fatalError("UniFFI start returned no output")
    }
    try engine.cancel(
        cancellationIdHigh: cancellationHigh,
        cancellationIdLow: cancellationLow)
} catch {
    fatalError("UniFFI workflow call failed: \(error)")
}

do {
    try UniFfiEngine().startJson(
        commandJson: "{",
        capabilityBits: capabilities,
        cancellationIdHigh: 0,
        cancellationIdLow: 1)
    fatalError("UniFFI accepted invalid command JSON")
} catch UniFfiSmokeError.Failure(let message) {
    guard message.contains("command JSON") else {
        fatalError("UniFFI returned the wrong error: \(message)")
    }
} catch {
    fatalError("UniFFI returned the wrong error type: \(error)")
}

print("UniFFI Swift smoke passed")
