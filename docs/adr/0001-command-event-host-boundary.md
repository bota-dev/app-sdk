# ADR 0001: Command, Event, and Host-Effect Boundary

- Status: Accepted
- Date: 2026-08-28

## Context

The Device SDK needs one deterministic implementation of protocol workflows
while retaining native Bluetooth and lifecycle ownership on Apple, Android,
Windows, Web, React Native, and Flutter. Selecting an FFI generator before the
workflow boundary is stable would couple core design to one tool's generated
API and supported languages.

## Decision

The Rust core exposes a reducer-style boundary:

```rust
let effects = engine.start(command, &capabilities, cancellation_id)?;
let next_effects = engine.dispatch(Event::Host(host_event))?;
```

Applications submit typed commands after capability authorization. Platform
callbacks enter as typed events. The core requests host work through typed
effects for timers, persistence, secure storage, BLE, network transfer, and
progress. Every effect request carries a monotonic request ID, stable operation,
and cancellation ID. A host callback must echo the request ID it completes; the
engine rejects stale or unrelated callbacks. One workflow owns the engine at a
time, and cancellation is scoped to that workflow's cancellation ID.

Checkpoints contain workflow phase, stable device/recording identity, progress,
and retry count only. Credentials, presigned URLs, private keys, file paths,
recording content, and other payload bytes remain host-owned and are referenced
through opaque request IDs where coordination is required.

Milestone 1 defined this vocabulary and its invariants. Milestone 2 adds
reducers; deterministic discovery is implemented first, while reconnect,
provisioning, transfer, upload, OTA, device-log, and reset remain deferred.

## FFI Decision Gate

Milestone 2 must compare at least one binding generator with a manually owned C
ABI. The spike must measure and record:

- Swift, Kotlin/JNI, C#, and Dart support;
- async cancellation and event delivery behavior;
- copies and ownership transitions for large byte buffers;
- generated-code reviewability and API stability;
- binary-size impact for each shipping platform;
- compatibility with the repository dependency-license gate;
- reproducible CI builds and pinned toolchains.

No generator is adopted solely because it targets more languages. Web remains
a native TypeScript facade because browsers cannot load this native Rust core
for Web Bluetooth without a separate WASM/browser design and security review.

## Consequences

- Core workflows can be deterministic and testable without Bluetooth, HTTP,
  filesystem, thread, or async-runtime dependencies.
- Native facades retain control over OS permissions, background execution,
  Bluetooth identity, transport buffers, and secure storage.
- The public facade can remain stable while the FFI mechanism is evaluated.
- Hosts must implement the declared capability and effect contracts.
