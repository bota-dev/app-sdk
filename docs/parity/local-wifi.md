# Local WiFi transport and recovery

Local WiFi is an opt-in carrier for ordinary encrypted-v2 batch recordings.
It reuses the current SDK task/provider, cloud recording, durable device owner
and signed receipt/CONFIRM. Bluetooth remains the default. The manifest registers
B07A000B, profile-2 capability/control/events and channel 4; existing capabilities,
recording identities and signed document sizes retain their meanings.

## Selection and component ownership

The public sync options and managed target accept `transport: 'local_wifi'`.
Omission uses BLE. The host rejects unsupported ports/profile or marked/BYO local
recordings before acquiring backend authority. Independent local capabilities
are supplied alongside the unchanged encrypted-v2 capability bytes. There is no
automatic channel takeover or second upload queue.

| Component | Responsibility |
| --- | --- |
| Rust local control/receive modules | Exact codecs, signed-purpose/AEAD framing, counters, receive/checkpoint transitions and immutable object checks |
| Existing managed provider | Scoped recording/session identity, authorization, verified recovery ancestry and cloud completion reconciliation |
| JS local host | Protected QUERY/PREPARE/OPEN, durable file writes/readback, bounded Range, FINISH, CLOSE/OFF and retained evidence |
| Native IO port | Captured-owner hotspot lease, TLS 1.3 with exact SPKI pin, bounded reads and joined cancellation |
| App host | Permissions, physical-connection owner fencing, explicit UI and background/Stop cancellation |

The [control contract](../../protocol/local-wifi-control-v1.md) reuses the enrolled
P-256 identity, current binding and backend signed HPKE. The App's `assertOwner`
callback fences lifecycle only; authenticated encrypted QUERY supplies protocol
key proof. Neither control keys nor temporary network credentials are persisted.
A new transport grant does not replace recording authorization or deletion proof.

## Receive, shutdown and completion

Fresh authenticated PREPARED/manifest evidence precedes network IO. HTTP validates
status, exact object/ETag, Content-Range and content length. File bytes and prefix
checkpoints must be durably persisted/read back before FINISH. A verified complete
file skips another GET; cloud completion reconciliation skips duplicate staging.
Only the original signed receipt followed by device CONFIRM authorizes deletion.

Cancellation closes the phone lease and joins active IO before another owner can
start. Both CLOSE write and OFF wait are bounded. Failed shutdown reports
`cleanup_incomplete` and retains the uncertain-owner fence and durable evidence;
it cannot be relabelled success. The App stops the remaining local batch after a
failure. Current managed scheduling closes the AP per recording before cloud
publication and the next authorization. Continuous cross-recording AP reuse,
grant renewal and background auto-transfer are not implemented.

## Authorized successor recovery

After a verified `AcceptRecovery`, the existing managed journal retains the exact
previous upload session/owner as a recovery parent. Rust accepts a checkpoint
migration only for that durable ancestry and matching account/project/binding/
recording scope. Merely increasing the owner revision is insufficient.

Fresh successor PREPARED/manifest evidence must match recording UUID/generation,
ciphertext size/hash and the retained prefix/offset. The host verifies actual file
bytes, then persists and reads back the migrated checkpoint before Range or
FINISH. Only session/owner and the new session-bound manifest hash change. Ordinary
resume remains strict. Complete files skip GET; partial files resume at the
verified offset, including after App restart.

Recovery history is bounded to 64 unique ascending parents and fails closed when
that limit is exceeded. The extended journal cannot be downgraded into an older
SDK while unfinished recovery evidence is retained; preserve it until normal
completion instead of deleting or silently rewriting it.

## Standalone native packaging

`/runtime` remains safe to import without a full native workflow engine.
`createNativeLocalWifiPort` bridges only network IO. A consumer that already owns
BLE must opt into `/native-io` rather than autolink another SDK workflow.

For Expo, Android uses `sourceDir: 'native-io/android'` relative to the installed
package. Expo does not honor a dependency-level root override. Bota One disables
SDK iOS autolinking and its config plugin inserts only the standalone pod. Old
packages without `/native-io` retain BLE behavior. New native binaries are required;
an OTA update alone cannot supply hotspot/TLS support.

Standalone source copies are generated from canonical Apple/Android sources:

```sh
node frameworks/react-native/scripts/prepare-local-wifi-native.mjs
node frameworks/react-native/scripts/prepare-local-wifi-native.mjs --check
```

Never edit those copies directly. The native module owns no BLE connection,
upload queue, Rust engine or protocol policy.

## Verification and delivery boundary

Run Rust `local_wifi`, `local_wifi_transfer` and managed-upload regressions;
regenerate the JS core on the prescribed Linux/Rust/Binaryen toolchain; run RN
host/package tests, strict types, Codegen and package checks. Native host checks
are available through `python3 tools/local-wifi/check-transports.py --bridge`;
they need the documented cached Android/Swift toolchains and local loopback.
Exact results and candidate build evidence belong in the implementation PR.

Source and private Android candidate validation do not establish public SDK/App
adoption, a complete iOS build, backend rollout or real-device acceptance. The
JieLi reference keeps its source/board gates off; the external team supplies the
BES port and identifiable firmware for joint testing. See the
[single completion checklist](https://github.com/bota-dev/internal-docs/blob/feat/local-wifi-sync/device/App-Local-WiFi-Protocol-Contract.md#9-single-completion-checklist).
