import type { DeviceRecording, RecordingDataStore, UploadInfo, UploadRecoveryProvider } from '../models/Recording';

export interface RecordingManagerOptions {
  uploadRecoveryProvider?: UploadRecoveryProvider;
  /** Allow automatic retained-upload recovery and completed-file release; manual operations remain available. */
  backgroundSyncEnabled?: boolean;
  /** Unsupported: recording bytes remain native-owned. Configuration throws. */
  recordingDataStore?: RecordingDataStore;
}

export type UploadInfoProvider = (
  recording: DeviceRecording
) => Promise<UploadInfo>;

export interface FirmwareInfo {
  version: string;
  url: string;
  checksum: string;
  releaseNotes?: string;
  size: number;
}

export type OtaStage =
  | 'checking'
  | 'downloading'
  | 'preparing'
  | 'updating'
  | 'verifying'
  | 'restarting'
  | 'completed'
  | 'failed';

export interface OtaProgress {
  stage: OtaStage;
  progress: number;
  bytesTransferred?: number;
  totalBytes?: number;
  error?: string;
}

export type FirmwareDownloadProgressCallback = (
  bytesDownloaded: number,
  totalBytes: number
) => void;
