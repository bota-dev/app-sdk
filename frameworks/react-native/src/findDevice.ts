import type { NativeConnectedDevice } from './specs/NativeBotaDeviceSDK';
export type FindDeviceCapabilities = { supported: boolean; protocolVersion: number; bindingReady: boolean; defaultDurationSeconds: number; maxDurationSeconds: number };
export type FindDeviceStatus = { active: boolean; protocolVersion?: number; reason?: string | null; success: boolean; error: string | null; requestId: string; remainingMs: number };
export type FindDeviceRequest = { requestId: string; action: 'start' | 'stop'; durationSeconds: number; grantBlob: string; protocolVersion?: 1 | 2 };
/** Additive runtime capability. Older/native-only adapters fail before any write. */
export interface FindBindingProvider {
  issue(nonce: string): Promise<string>;
  acknowledge(acknowledgement: string): Promise<void>;
}
export interface FindDeviceAdapter {
  readFindChallenge(device: NativeConnectedDevice): Promise<string>;
  readFindBindingChallenge(device: NativeConnectedDevice): Promise<string>;
  confirmFindBinding(device: NativeConnectedDevice, confirmation: string): Promise<string>;

  readFindCapabilities(device: NativeConnectedDevice): Promise<FindDeviceCapabilities>;
  readFindStatus(device: NativeConnectedDevice): Promise<FindDeviceStatus>;
  requestFindDevice(device: NativeConnectedDevice, request: FindDeviceRequest): Promise<FindDeviceStatus>;
}
