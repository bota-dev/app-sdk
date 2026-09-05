// Keep source on main compatible with the most recently published Apple binary.
// The next release artifact exports the same additive constants in its C header.
enum EncryptedUploadV2Abi {
    static let commandTransferEncryptedRecording: UInt32 = 0x010c

    static let eventCheckpointLoaded: UInt32 = 0x022b
    static let eventSinkTruncated: UInt32 = 0x022c
    static let eventSessionPrepared: UInt32 = 0x022d
    static let eventTransferStarted: UInt32 = 0x022e
    static let eventResumeRejected: UInt32 = 0x022f
    static let eventWindowStaged: UInt32 = 0x0230
    static let eventCheckpointSaved: UInt32 = 0x0231
    static let eventWindowAcknowledged: UInt32 = 0x0232
    static let eventTransferCompleted: UInt32 = 0x0233
    static let eventArtifactsStaged: UInt32 = 0x0234
    static let eventReceiptAccepted: UInt32 = 0x0235
    static let eventRecordingConfirmed: UInt32 = 0x0236
    static let eventMixedProfile: UInt32 = 0x0237
    static let eventFailed: UInt32 = 0x0238

    static let effectLoadCheckpoint: UInt32 = 0x0342
    static let effectDeleteCheckpoint: UInt32 = 0x0343
    static let effectTruncateSink: UInt32 = 0x0344
    static let effectPrepareSession: UInt32 = 0x0345
    static let effectStartTransfer: UInt32 = 0x0346
    static let effectRepairWindow: UInt32 = 0x0347
    static let effectSaveCheckpoint: UInt32 = 0x0348
    static let effectAcknowledgeWindow: UInt32 = 0x0349
    static let effectStageArtifacts: UInt32 = 0x034a
    static let effectAwaitReceipt: UInt32 = 0x034b
    static let effectConfirmWithReceipt: UInt32 = 0x034c
    static let effectAbort: UInt32 = 0x034d

    static let notificationStaged: UInt32 = 0x0410

    static let fieldSerialNumber: UInt32 = 3
    static let fieldMaterialID: UInt32 = 12
    static let fieldRecordingUUID: UInt32 = 13
    static let fieldSinkID: UInt32 = 14
    static let fieldCheckpoint: UInt32 = 28
    static let fieldOffset: UInt32 = 39
    static let fieldTransportSessionID: UInt32 = 128
    static let fieldRecordingGeneration: UInt32 = 129
    static let fieldCiphertextLength: UInt32 = 130
    static let fieldUploadSessionUUID: UInt32 = 132
    static let fieldCheckpointRevision: UInt32 = 133
    static let fieldWindowPackets: UInt32 = 134
    static let fieldDataPayloadBytes: UInt32 = 135
    static let fieldMissingSequence: UInt32 = 136
    static let fieldCapabilityFlags: UInt32 = 137
    static let fieldMaximumSignedBlobBytes: UInt32 = 138
    static let fieldMaximumManifestBytes: UInt32 = 139
    static let fieldCheckpointInterval: UInt32 = 140
    static let fieldMaximumMissingSequences: UInt32 = 141
    static let fieldManifestSHA256: UInt32 = 142
    static let fieldPrefixSHA256: UInt32 = 143
    static let fieldCiphertextSHA256: UInt32 = 144
    static let fieldBlockCount: UInt32 = 145
    static let fieldStorageFormat: UInt32 = 147
    static let fieldAuthorizationSHA256: UInt32 = 161
    static let fieldOwnerRevision: UInt32 = 165
    static let fieldUploadProfile: UInt32 = 166
    static let fieldUploadSecurityPolicy: UInt32 = 167
    static let fieldManifestLength: UInt32 = 168
    static let fieldMaximumDataPayloadBytes: UInt32 = 169
    static let fieldMaximumWindowPackets: UInt32 = 170
}
