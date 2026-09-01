import EventEmitter from 'eventemitter3';

import { getCompatibilityClient } from '../compatibility/runtime';
import type { ConnectedDevice } from '../models/Device';
import type { DeviceManager } from './DeviceManager';
import type {
  FirmwareDownloadProgressCallback,
  FirmwareInfo,
  OtaProgress,
  OtaStage,
} from './types';

interface OTAManagerEvents {
  updateAvailable: (firmware: FirmwareInfo) => void;
  progress: (deviceId: string, progress: OtaProgress) => void;
  completed: (deviceId: string, version: string) => void;
  failed: (deviceId: string, error: Error) => void;
}

interface FirmwareDownloadProgressEvent {
  loaded: number;
  total: number;
  lengthComputable: boolean;
}

interface FirmwareDownloadRequest {
  status: number;
  response: unknown;
  responseType: string;
  onprogress: ((event: FirmwareDownloadProgressEvent) => void) | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  open(method: string, url: string): void;
  send(): void;
}

type FirmwareDownloadRequestConstructor = new () => FirmwareDownloadRequest;

const stageForNativePhase = (phase: string): OtaStage => {
  switch (phase) {
    case 'downloading':
      return 'downloading';
    case 'awaiting_device':
      return 'preparing';
    case 'transferring':
      return 'updating';
    case 'verifying':
      return 'verifying';
    case 'rebooting':
    case 'reconnecting':
      return 'restarting';
    case 'complete':
      return 'completed';
    default:
      throw new Error(`Unknown firmware update phase: ${phase}`);
  }
};

export class OTAManager extends EventEmitter<OTAManagerEvents> {
  private readonly client = getCompatibilityClient();
  private destroyed = false;

  constructor(
    private readonly deviceManager: DeviceManager,
    private readonly firmwareCdnUrl = 'https://cdn.bota.dev/firmware'
  ) {
    super();
  }

  async checkForUpdate(device: ConnectedDevice): Promise<FirmwareInfo | null> {
    this.assertAlive();
    this.emit('progress', device.id, { stage: 'checking', progress: 0 });
    const response = await fetch(
      `${this.firmwareCdnUrl}/latest?device_type=${device.deviceType}&current=${device.firmwareVersion}`
    );
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Failed to check for updates: ${response.status}`);
    }
    const firmware = (await response.json()) as FirmwareInfo;
    if (!this.isNewerVersion(firmware.version, device.firmwareVersion)) return null;
    this.emit('updateAvailable', firmware);
    return firmware;
  }

  async downloadFirmware(
    firmware: FirmwareInfo,
    onProgress?: FirmwareDownloadProgressCallback
  ): Promise<ArrayBuffer> {
    this.assertAlive();
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const Request = (globalThis as unknown as {
        XMLHttpRequest?: FirmwareDownloadRequestConstructor;
      }).XMLHttpRequest;
      if (!Request) {
        reject(new Error('Failed to download firmware: XMLHttpRequest is unavailable'));
        return;
      }
      const request = new Request();
      request.open('GET', firmware.url);
      request.responseType = 'arraybuffer';
      request.onprogress = (event) => {
        const total = event.lengthComputable && event.total > 0
          ? event.total
          : firmware.size;
        onProgress?.(event.loaded, total);
      };
      request.onload = () => {
        if (request.status < 200 || request.status >= 300) {
          reject(new Error(`Failed to download firmware: ${request.status}`));
        } else if (!(request.response instanceof ArrayBuffer)) {
          reject(new Error('Failed to download firmware: empty response'));
        } else {
          resolve(request.response);
        }
      };
      request.onerror = () =>
        reject(new Error('Failed to download firmware: network error'));
      request.onabort = () =>
        reject(new Error('Failed to download firmware: request aborted'));
      request.send();
    });
  }

  async performUpdate(
    device: ConnectedDevice,
    firmware: FirmwareInfo,
    grantBlob?: string
  ): Promise<void> {
    this.assertAlive();
    try {
      if (grantBlob) await this.deviceManager.writeGrant(device, grantBlob);
      await this.client.ota.updateFirmware(
        device,
        {
          version: firmware.version,
          sizeBytes: firmware.size,
          crc32: 0,
          url: firmware.url,
        },
        (nativeProgress) => {
          if (this.destroyed) return;
          const total = nativeProgress.totalBytes;
          const progress: OtaProgress = {
            stage: stageForNativePhase(nativeProgress.phase),
            progress: total > 0
              ? Math.min(nativeProgress.completedBytes / total, 1)
              : 0,
          };
          if (nativeProgress.phase === 'downloading') {
            progress.bytesTransferred = nativeProgress.completedBytes;
            progress.totalBytes = total;
          }
          this.emit('progress', device.id, progress);
        }
      );
      if (!this.destroyed) this.emit('completed', device.id, firmware.version);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!this.destroyed) {
        this.emit('progress', device.id, {
          stage: 'failed',
          progress: 0,
          error: failure.message,
        });
        this.emit('failed', device.id, failure);
      }
      throw error;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.removeAllListeners();
    void this.client.ota.cancelFirmwareUpdate();
  }

  private isNewerVersion(newVersion: string, currentVersion: string): boolean {
    const newParts = newVersion.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const currentParts = currentVersion.split('.').map((part) => Number.parseInt(part, 10) || 0);
    for (let index = 0; index < Math.max(newParts.length, currentParts.length); index += 1) {
      const next = newParts[index] ?? 0;
      const current = currentParts[index] ?? 0;
      if (next > current) return true;
      if (next < current) return false;
    }
    return false;
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error('OTAManager has been destroyed');
  }
}
