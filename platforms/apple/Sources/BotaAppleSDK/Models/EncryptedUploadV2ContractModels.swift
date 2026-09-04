import Foundation

struct EncryptedUploadV2ContractValue: Equatable {
    let kind: UInt8
    let messageType: UInt8?
    let flags: UInt32?
    let transportSessionID: UInt64?
    let recordingUUID: String?
    let recordingGeneration: UInt32?
    let sequence: UInt32?
    let offset: UInt64?
    let length: UInt64?
    let result: UInt16?
    let authorizationSHA256: Data?
    let ciphertextSHA256: Data?
    let prefixSHA256: Data?
    let manifestSHA256: Data?
    let receiptSHA256: Data?
}
