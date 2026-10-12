# React Native portable runtime and OTA boundary

October 12, 2026 source implementation. The owner requested an independently
implemented React Native control plane with fewer dependencies on native
implementation details and support for compatible JavaScript OTA updates.
This supersedes the facade-only RN control-plane assumption. Package publication,
application delivery and physical acceptance are separate checks.

## Runtime contract

`@bota.dev/react-native-app-sdk/runtime` builds and loads without React Native's
registry, Apple artifacts, Android artifacts or a Rust runtime. It accepts a
`BotaReactNativeAdapter` with `apiVersion: 1`, a device adapter and an optional
managed-backend adapter. These are asynchronous method/event contracts; they do
not name Swift, Kotlin or Rust implementation classes. Their semantic contract
must still hold, including verified identity and terminal cancellation.

The ordinary package entry selects the installed native adapters and uses this
same runtime. It preserves the singleton API and all 80 frozen exports. Custom
runtimes have separate manager graphs, queues and subscriptions. Streaming
sessions capture their originating runtime, including after another runtime is
constructed. Adapter objects are captured when a runtime is created; consumers
must not mutate or replace their methods while operations are active.

`supports(operation)` checks that an operation and its required event, response
and cancellation methods exist. Each workflow preflights before subscribing or
starting a device effect. An unsupported feature returns
`BotaRuntimeCompatibilityError` with `native_operation_unavailable` and the
operation name. It does not cause unrelated supported operations to fail. Missing
passive presence on an otherwise installed adapter returns `null`. An unknown
adapter API version fails construction with `native_contract_unsupported`.

Foreground reconnect attempts and backoff are TypeScript policy. The default
remains one attempt. A caller may choose at most ten attempts and a delay of
zero through 60 seconds. Only an explicitly `retryable: true` failure permits
another attempt. Destroy interrupts backoff and suppresses late results. The
returned fresh native identity must equal the requested serial; a mismatched
connection is disconnected and rejected. Names never establish identity.

## OTA and native responsibilities

Changing TypeScript policies, callbacks, manager behavior or app UI can use the
installed adapter contract without updating its native package version. App OTA
deployment must still match the application's native runtime and be tested on
that runtime. Publishing npm source alone does not update an installed app.

The default adapter still uses the existing native protocol/file engines. Bulk
audio and firmware bytes, cryptographic envelopes, native file transfer,
background execution and durable device cleanup remain native. Signed manifests,
authorizations, receipts and ciphertext do not enter JavaScript. This change adds
no BLE-only native driver and does not make native bug fixes OTA-deliverable.
Adapter availability cannot compensate for incorrect native transport behavior.
Smaller alternative adapters must pass the same identity, completion, cancellation
and recovery contracts before adoption.

Cloud commitment remains separate from cleanup. A legacy `uploaded` response,
pending completion, a transport ACK or reconnect never authorizes deletion.
Existing receipt/CONFIRM and generation fences remain unchanged. See
[upload recovery](upload-recovery.md) and [managed v2](v2-managed-backend.md).

Firmware reboot recovery now also belongs to the TypeScript control plane. A
failed native update may enter read-back recovery only after a `rebooting` or
`reconnecting` progress event, which the existing contract emits after successful
image verification. Transfer, CRC rejection and explicitly permanent failures
cannot enter this recovery. One two-minute post-verification budget includes time
already spent in native recovery; JavaScript does not add a second budget.
Success requires a fresh exact serial and the requested firmware version. It
never retransmits firmware, reissues verification or treats an ACK as installed
version proof. Cancellation joins the exact native reconnect; failed cancellation
retains the JS operation owner until final shared-client destruction.

## Design review

| Requirement | Evidence | Status |
|---|---|---|
| Independently built TypeScript runtime | Bob CommonJS/ES module/declaration builds; package `/runtime` import with native imports rejected | matched |
| Interchangeable conforming platform implementations | iOS/Android adapter fixtures; independent manager graphs and backend bindings | matched |
| OTA-compatible policy over a stable interface | Version 1 adapter; foreground retries changed without changing adapter; fixed Codegen contract | matched |
| Older/partial adapters preserve supported operations | Capability, encrypted workflow and managed backend preflight tests | matched |
| Correct identity, cancellation and lifecycle | Serial mismatch disconnect; abort/backoff; disconnect listener lifecycle regressions | matched |
| OTA-editable verified reboot recovery | Old-native failure, fresh identity/version, pre-verification rejection, one deadline and cancellation ownership regressions | matched |
| Frozen RN public API and recovery behavior | Semantic 80-export contract and existing compatibility/upload suites | matched |
| Minimum native engine implementation | Current default still uses full native facades; no BLE-only replacement driver in this change | partial |
| New app OTA on installed production binaries; physical BLE parity | Requires consuming-app deployment and physical acceptance | unverified |

Local React Native suite: 226 tests pass, including 13 portable-runtime and nine
firmware recovery regressions. Type checking, package verification and license checks are separate
from exact-source hosted native consumer checks. Keep hosted delivery evidence
with the integration commit; no physical qualification follows from these tests.
