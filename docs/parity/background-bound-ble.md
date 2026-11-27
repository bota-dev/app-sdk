# Background BLE for a bound mobile device

A host using the generated React Native runtime can opt into background BLE by providing
`backgroundBle` to `createBotaReactNativeJsRuntime`. After verifying an active binding,
call `devices.enableAutoReconnect(serial)`. The SDK retains the verified physical ID
for the live session, shares one system request with foreground callers, runs the
existing Rust serial check and the port's security admission on return, then starts
a new status monitor. Listen for `deviceConnected`, `deviceDisconnected` and
`deviceStatusUpdated` at the app root. Call `disableAutoReconnect()` on explicit
disconnect/unbind or `await pauseAutoReconnect()` to join teardown. Scope changes
must retire the runtime. The initial foreground discovery flow remains available.

Use the SDK's narrow native-io target on both platforms. Pass its
`BotaBleSession` module and the host visibility check to
`createBackgroundBleSession`. Resume the session when the host becomes visible.
The helper checks the native methods. Android reports availability after the
connected-device foreground service has been promoted.

- On iOS, declare `bluetooth-central` and a Bluetooth usage description. Core
  Bluetooth holds the known-peripheral request. After a transient failure the
  SDK immediately resubmits once, then uses native, cancellable delays of
  2–8 seconds with bounded UIKit execution time. Execution-time expiration
  ends that attempt.
- On Android, declare `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`
  and Bluetooth permissions. Grant runtime permissions in the foreground. GATT
  auto-connect and a visible connected-device service own the session; native
  Handler delays increase from 2 to 30 seconds.
- Rust chooses retries after link, identity-read transport, or subscription
  failures. A serial mismatch, explicit cancellation, or unconfirmed cleanup
  terminates recovery. `devices.disconnect(originalDevice)` also cancels a
  pending request for that device. A recovered connection is announced after
  its new status monitor has registered.

These contracts cover normal backgrounding and lock within a live session.
Force-quit, process termination and recording transfer during lock have separate
qualification requirements. Firmware advertising intervals are integration measurements.

## Resuming a V2 recording after a phone Bluetooth power cycle

Powering off Bluetooth retires the current GATT connection. When the adapter
returns, a host with automatic reconnection enabled can observe `bluetoothReady`
on `devices` and wait for `deviceConnected` before retrying the same recording.
An explicit disconnect requires the user to request reconnection.

After a durable `WINDOW_ACK`, an eligible retry uses `RESUME_REQUEST` with the
original upload session, transport ID and confirmed byte offset. A new connection
still performs the bound-device security and identity checks. Before the first
checkpoint the transfer starts at byte zero. If the server selects a successor
session, its authorization governs the next transfer.
