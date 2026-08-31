import type { WiFiStatusInfo } from '../models/Device';

export interface CachedDeviceState {
  wifiStatus?: WiFiStatusInfo;
  updatedAt: number;
}

export interface DeviceStatePatch {
  wifiStatus?: Partial<WiFiStatusInfo> | null;
}

export interface DeviceStateCacheEvents {
  stateChanged: (
    serialNumber: string,
    patch: DeviceStatePatch,
    state: CachedDeviceState
  ) => void;
  cleared: (serialNumber: string) => void;
  clearedAll: () => void;
}
