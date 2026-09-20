import type { DeviceRecording } from './models.ts'

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
  sha256Hex: string | null
  encrypted: boolean
}

// Task 7 replaces these closed placeholders with the v2 provider contract.
export type EncryptedUploadV2ProviderContext = never
export type EncryptedUploadV2Material = never

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
