import type { DeviceRecording, UploadInfo } from '../models/Recording';

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
