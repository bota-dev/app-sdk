import type { NativeConnectedDevice } from './specs/NativeBotaDeviceSDK';
export type FindDeviceCapabilities = { supported: boolean; defaultDurationSeconds: number; maxDurationSeconds: number };
export type FindDeviceStatus = { active: boolean; success: boolean; error: string | null; requestId: string; remainingMs: number };
export type FindDeviceRequest = { requestId: string; action: 'start' | 'stop'; durationSeconds: number; grantBlob: string };
/** Additive runtime capability. Older/native-only adapters fail before any write. */
export interface FindDeviceAdapter {
  readFindCapabilities(device: NativeConnectedDevice): Promise<FindDeviceCapabilities>;
  readFindStatus(device: NativeConnectedDevice): Promise<FindDeviceStatus>;
  requestFindDevice(device: NativeConnectedDevice, request: FindDeviceRequest): Promise<FindDeviceStatus>;
}
