import type {
  DeviceRecording,
  EncryptedUploadV2Capabilities,
} from './models.ts'

export interface UploadRequestTemplate {
  method: 'PUT'
  url: string
  headers: Readonly<Record<string, string>>
}

export interface LegacyUploadContext {
  operationId: string
  serialNumber: string
  recording: DeviceRecording
  sizeBytes: bigint
  plaintextSha256Hex: string | null
  stagedBodySha256Hex: string
  encrypted: boolean
}

export interface EncryptedUploadV2Recording {
  uuid: string
  generation: number
  storageFormat: number
  ciphertextLength: bigint
  ciphertextSha256: Uint8Array
}

export interface EncryptedUploadV2CheckpointSummary {
  uploadSessionId: string
  ownerRevision: number
  checkpointRevision: number
  nextCiphertextOffset: bigint
  prefixSha256: Uint8Array
  transportSessionId: bigint
  sinkId: string
  windowPackets: number
  dataPayloadBytes: number
}

export interface EncryptedUploadV2ProviderContext {
  operationId: string
  serialNumber: string
  recording: EncryptedUploadV2Recording
  capability: {
    rawValue: Uint8Array
    sha256: Uint8Array
    decoded: EncryptedUploadV2Capabilities
  }
  checkpoint: EncryptedUploadV2CheckpointSummary | null
}

export interface EncryptedUploadV2Evidence {
  ciphertextLength: bigint
  ciphertextSha256: Uint8Array
  manifestLength: number
  manifestSha256: Uint8Array
  blockCount: number
}

export interface EncryptedUploadV2Material {
  materialId: string
  recordingId: string
  uploadSessionId: string
  ownerRevision: number
  policy: 'legacy_allowed' | 'v2_preferred' | 'v2_required'
  authorization: Uint8Array
  stagingRequest(
    evidence: EncryptedUploadV2Evidence,
  ): Promise<UploadRequestTemplate>
  submitManifest(
    manifest: Uint8Array,
    evidence: EncryptedUploadV2Evidence,
  ): Promise<void>
  finalize(evidence: EncryptedUploadV2Evidence): Promise<void>
  completionReceipt(
    evidence: EncryptedUploadV2Evidence,
  ): Promise<Uint8Array>
  cancel(): Promise<void>
}

export interface RecordingUploadProvider {
  prepareLegacyUpload(context: LegacyUploadContext): Promise<{
    uploadId: string
    request: UploadRequestTemplate
  }>
  completeLegacyUpload(
    context: LegacyUploadContext & { uploadId: string },
  ): Promise<{ cloudCompletionId: string }>
  reconcileLegacyUpload(
    context: LegacyUploadContext & { uploadId: string },
  ): Promise<
    | { state: 'not_uploaded' }
    | { state: 'cloud_completed'; cloudCompletionId: string }
  >
  prepareEncryptedUploadV2(
    context: EncryptedUploadV2ProviderContext,
  ): Promise<EncryptedUploadV2Material>
}
