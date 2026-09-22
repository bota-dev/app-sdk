import {
  BotaDeviceClient,
  type ControlManager,
  type DeviceManager,
  type LogManager,
  type OTAManager,
  type ProvisioningManager,
  type RecordingManager,
  type WiFiManager,
} from '../index.ts'
import * as sdk from '../index.ts'

declare const client: BotaDeviceClient

const managerInstances: readonly [
  DeviceManager,
  RecordingManager,
  ProvisioningManager,
  WiFiManager,
  ControlManager,
  OTAManager,
  LogManager,
] = [
  client.devices,
  client.recordings,
  client.provisioning,
  client.wifi,
  client.controls,
  client.ota,
  client.logs,
]

void managerInstances

// @ts-expect-error Managers are instance types, not root constructor values.
void sdk.DeviceManager
// @ts-expect-error Managers are instance types, not root constructor values.
void sdk.RecordingManager
// @ts-expect-error Managers are instance types, not root constructor values.
void sdk.ProvisioningManager
// @ts-expect-error Managers are instance types, not root constructor values.
void sdk.WiFiManager
// @ts-expect-error Managers are instance types, not root constructor values.
void sdk.ControlManager
// @ts-expect-error Managers are instance types, not root constructor values.
void sdk.OTAManager
// @ts-expect-error Managers are instance types, not root constructor values.
void sdk.LogManager

// @ts-expect-error Core bridge internals are not root exports.
void sdk.CoreBridge
// @ts-expect-error Runtime internals are not root exports.
void sdk.BrowserWorkflowRuntime
// @ts-expect-error Transport internals are not root exports.
void sdk.WebBluetoothTransport
// @ts-expect-error Storage internals are not root exports.
void sdk.createDefaultBrowserStorage
