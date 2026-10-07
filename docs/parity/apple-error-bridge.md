# Apple error bridge

Unreleased source preserves the typed `BotaSDKError` through Swift-to-Objective-C
`NSError` bridging. It conforms to Foundation's
[`CustomNSError`](https://developer.apple.com/documentation/foundation/customnserror)
and `LocalizedError`; typed error construction and workflow decisions stay the
same. No SDK package or consuming application is published by this change.

The error domain remains `BotaAppSDK.BotaSDKError`. Numeric codes retain the
existing ABI meanings 1 through 21, and unknown codes retain their numeric value.
The localized description is the native `detail`; empty detail uses the stable
error and operation names, for example `device_not_found during reconnect`.
`userInfo` carries `botaErrorCode`, `botaOperation`, `retryable`, and
`protocolStatus` only when present. Existing React Native promise rejection codes
remain unchanged; their underlying native error now retains this metadata.

## Verification and design review

The current native-facade design requires structured, stable error translation.
The original [test-only CI run](https://github.com/bota-dev/app-sdk/actions/runs/37526879959)
at `7ed0140` compiled the regression tests and failed all four with 33 assertions:
non-one numeric identities, descriptions, retry policy, and protocol status were
lost during bridging. The implementation is unchanged in those model paths on
the integration base, so this is the before-fix evidence.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Preserve structured native errors across Foundation bridging | `BotaSDKError` conformances and regression tests | unverified until hosted tests |
| Preserve all 21 ABI numeric identities and unknown values | Existing mapper plus numeric round-trip and unknown-code regressions | unverified until hosted tests |
| Retain detail, operation, retryability and optional protocol status | Reconnect, provisioning, empty-detail and read-status regressions | unverified until hosted tests |
| Integrate useful branch work while retaining newer main fixes | Six branch histories integrated; current security locks and agent guidance retained | matched in source |
| Dependency updates and Flutter instruction inventory remain valid | Frozen npm installation; canonical Flutter archive generator; full CI and License Gate required before main | partial; local installation and inventory passed |

Exact integration-revision CI must cover the Apple suite with strict concurrency
and warnings treated as errors, native and React Native consumers, Rust/UniFFI,
Web, Flutter, release inventory and License Gate. Hosted results will be recorded
in the delivery evidence before branch cleanup. Physical reconnection and
application installation remain unverified by these controlled tests.
