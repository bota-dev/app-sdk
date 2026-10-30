# Watch cloud control adapter

Swift source product in the Bota App SDK for developers building their own Apple Watch apps.
It calls existing device command APIs over HTTPS and exposes a small SwiftUI
Double Tap integration. It does not contain an app, screen, login flow, account
store, device picker, recording UI state machine, polling service, or journal.

The customer owns authentication, authorization, token renewal, device ownership,
selection, business state, persistence, retry decisions and application lifecycle.
The device continues receiving commands through its existing Wi-Fi/cellular HTTP
connection. No phone application or Bluetooth relay is required by this module.

## Integrate the unpublished source

The root `Package.swift` and release generator export `BotaWatchControl` as a
separate source product. Select that product in the Watch target, rather than
the binary-backed `BotaAppSDK` product. No Rust/XCFramework, React Native,
authentication SDK or third-party dependency is linked by `BotaWatchControl`.
This is an unpublished source change, not support in an existing version tag.
The CocoaPod still contains only the existing iOS/macOS facade.

SwiftPM can resolve/download the package's native binary artifact even when
only the source product is selected. Root-package integration therefore also
requires the pinned release asset to exist. Until publication, add
`platforms/watch` as a local Swift package for source-only development, or use
the root-consumer CI fixture with the same-checkout native artifact. This
fixture does not establish public artifact availability.

The source product declares watchOS 11+, iOS 15+ and macOS 13+. macOS is used for local
contract checks; actual watchOS builds and physical gesture acceptance are
separate gates.

## Call existing commands

```swift
import BotaWatchControl

let client = WatchCloudClient(
    configuration: try WatchConfiguration(baseURL: customerAPIURL),
    requestHeaders: {
        // Customer code owns sign-in, expiry, refresh and account changes.
        // Throw if the captured customer session is no longer authorized.
        try await customerSession.authorizedHeaders()
    }
)

let request = try client.makeIntent(
    deviceID: selectedDeviceID,
    action: .startRecording,
    ttlSeconds: 60
)
// Persist the intent in the application if recovery is needed.
let command = try await client.submit(request)
// Accepted/pending/delivered are not recording success.
let latest = try await client.command(deviceID: selectedDeviceID, commandID: command.id)
let state = try await client.state(deviceID: selectedDeviceID)

// A separate, explicit user action stops recording.
let stop = try client.makeIntent(deviceID: selectedDeviceID, action: .stopRecording)
let stopCommand = try await client.submit(stop)
```

The default route prefix is `/devices`; set `devicesPath` for a compatible
customer route prefix. An optional `WatchHTTPTransport` lets the customer supply
their own HTTP executor. `requestHeaders` may return an empty dictionary when
that executor supplies authorization. The default executor uses ephemeral
URLSession HTTPS, refuses redirects and limits response bodies to 1 MiB.
Request headers are neither retained by the SDK nor logged. Do not embed a Bota
project secret in an app; an endpoint requiring that secret must be called by
the customer's backend.

| API | Existing HTTP route |
| --- | --- |
| `submit(intent)` | `POST {devicesPath}/{id}/commands` |
| `state(deviceID:)` | `GET {devicesPath}/{id}/state` |
| `devices(cursor:)` | `GET {devicesPath}` with optional cursor |
| `command(deviceID:commandID:)` | Read-only list and exact ID match by default; configured `.detail` uses existing `GET {devicesPath}/{id}/commands/{commandId}` |
| `recover(intent)` | Same read-only list, matched by `params.metadata.watch_request_id` |

No `/watch/v1` API is required. The adapter never calls `/commands/pending`,
which claims commands, and never acknowledges execution on the device's behalf.
The customer backend must preserve the existing command request/response shape,
including `params.metadata`, `idempotency_key` and `ttl_seconds`.

Each intent contains one stable request ID and an absolute local deadline.
`submit` does not automatically retry. If the response is lost, reuse the same
intent within its deadline or call `recover`; never silently make a new start.
The remaining TTL is checked after the customer supplies headers and rounded
up by less than one second to the API's whole-second TTL. A request below the
server's ten-second minimum is refused. This limits
client submission time; it does not replace the server/device expiry contract.
The default list-based lookup is deliberately compatible with existing App
backends and requests their existing maximum `limit=100`. This route does not
support cursor pagination. A command absent from that window remains unknown,
not failed. For backends exposing the existing single-command endpoint, set
`WatchConfiguration(commandLookup: .detail)` to look up known IDs directly;
404 remains an HTTP error, not execution failure. Recovery by request metadata
still uses the bounded list and never silently submits a new command.
The application decides when to poll, show errors or reconcile device state.

Bind the header provider to the intended customer session. On logout, account or
workspace change, cancel outstanding application tasks and discard that client
and its UI results. The SDK validates endpoint/device/action identity, but does
not implement customer session fencing or server-side ownership authorization.

Both HTTP transport and per-request headers are I/O extension points. The header
provider defaults to an empty dictionary so customers can reuse their existing
authorized HTTP transport without a second authorization callback. Preparation
errors return `requestPreparationFailed`, without inferring a login failure.
Cancellation and typed transport errors are preserved; arbitrary transport
details are not exposed. The default URLSession transport rejects redirects and
bounds response bodies to 1 MiB.

## Connect the customer's gesture action

```swift
Button("Start recording") {
    // Customer handler controls admission, busy state and the SDK call above.
    startSelectedRecorder()
}
.disabled(isSending)
.botaPrimaryHandGesture(isEnabled: !isSending)
```

The modifier designates the customer's visible control as the primary system
Double Tap action on supported watches. The customer chooses which action it
performs and provides its enabled state. Only one primary control should be
designated in a scene. Normal taps use the same button handler.

This is not a global/background gesture detector or an API for arbitrary hand
gestures. Availability still depends on Apple's supported hardware and system
settings. There is no guarantee for a locked or inactive watch screen. Outside
watchOS the modifier leaves the view unchanged. See Apple's
[Double Tap documentation](https://developer.apple.com/documentation/watchos-apps/enabling-double-tap).
`Example/PrimaryActionExample.swift` is an integration snippet, not an SDK-owned
application screen.

## Check the source

```bash
bash tools/apple/test-watch-control.sh
```

Run from the repository root with Swift 6. The executable checks use assertions
without XCTest/Swift Testing, so they also run with the macOS command-line tools.
CI additionally uses `test-watch-root-consumer.sh` to compile an external
consumer against the root product graph for watchOS device and simulator. Only
the remote native artifact location is substituted with the real native
artifact built earlier in that CI checkout. A future published tag still needs
the unmodified remote-package consumer check. No live
account or physical recorder is accessed by these checks.

Publication, developer-owned application integration, watchOS compilation and
physical phone-lock/gesture acceptance are tracked in
[the implementation review](../../docs/parity/watch-cloud-control.md).
