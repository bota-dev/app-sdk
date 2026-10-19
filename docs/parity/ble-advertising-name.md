# BLE Advertising Name and Serial Identity

October 19, 2026. Approved naming contract: canonical model name, one ASCII
space, and the last four characters of the manufacturing serial number.
Example: `EVFXXW67KP` on Pin advertises `Bota Pin 67KP`.

Preserve serial character case; never use a MAC suffix or fabricate padding.
Absent, shorter-than-four, unterminated or non-ASCII-alphanumeric stored serials
produce the model name alone. Current firmware model names are `Bota Pin`,
`Bota Note` and `Bota Pin Pro`; an unknown model retains its existing fallback,
which must not be interpreted as verified model identity. Manufacturing display
overrides remain stored but do not override this standardized BLE name.
Firmware resolves the name at BLE initialization; an identity write requires
the existing restart/reinitialization path before its advertisement changes.

The name is sent as Complete Local Name in the normal scan response and exposed
as the GAP name. The longest supported name is 17 ASCII bytes, within the
19-byte name budget after the existing manufacturer-data AD structure. No new
GATT characteristic, service, manufacturer-data field or protocol version is
allocated. Full serial reads remain `180A/2A25`, with `B07A0008/0001` for Web.

## SDK Behavior

Scan results retain the complete advertised name. There is no replacement of
`serialNumber` with the four-character suffix and no new public identity field.
Existing exact peripheral/address hints retain priority. When those do not
match, the Rust reconnect workflow allows a saved model-only name and the same
model plus the target serial's suffix to select probe candidates in either
direction. A saved custom display name may select a canonical name carrying
the expected suffix. Existing exact-name matching remains supported; a known
canonical model does not migrate to a different model or suffix by this rule.
Historical `Bota Pin 4G` spelling is
recognized for SDK reconnect compatibility only, not a new firmware model code.

Candidates with identical tails may collide. Probe them under the existing
single-owner workflow, read the full serial after connection and service
discovery, disconnect a mismatch, then try the next candidate. Persist identity
only after the full match. Neither name, suffix, RSSI nor a full serial read
substitutes for the existing binding/grant authorization.

## End-to-End Completion Checklist

This is the single checklist for the cross-repository change.

Related reviews: [firmware #51](https://github.com/bota-dev/firmware/pull/51),
[internal design #33](https://github.com/bota-dev/internal-docs/pull/33), and the
[consolidated protocol reference #41](https://github.com/bota-dev/app-sdk/pull/41).
The [Notion PROTO-001 companion](https://app.notion.com/p/3f3fb1290ea0816d93c8d3b1193bdffb)
was updated and read back on October 19, including the naming contract and the
previously agreed customer-envelope BYO completion flow.

- [x] Firmware resolver uses canonical model plus stored serial tail and retains full GATT identity.
- [x] C regression fails before the change and passes after it; current-model regression remains green.
- [x] SDK reconnect regression fails before the change and passes after it, including a suffix collision and full-serial rejection.
- [x] Canonical Linux generated-JS artifact and SDK verification.
- [x] Repository and Notion protocol synchronization/readback.
- [x] Review and source delivery through SDK #42, firmware #51 and internal design #33.
- [ ] Target firmware build/installation and physical advertising, reconnect and recording-transfer acceptance.
- [ ] SDK package publication and consuming App qualification.

## Conformance Review

The compound-engineering skill is unavailable; this direct review records the
requirements and evidence. Firmware uses the actual production resolver with
bounded serial validation, not a second implementation in the test. SDK tests
exercise the real workflow, including old/new names, same-suffix devices and
disconnect-before-next-probe ordering. Generated JS is rebuilt from this
Rust source and separately exercises the rename/collision trace. Missing physical/release evidence is separate from
source completion; no device was provisioned, reset, flashed or deleted here.

Local verification passes all 239 core Rust tests (14 connection workflow
tests), strict core Clippy, 564 React Native tests, normal package build, types,
Codegen, metadata and dependency licenses, including the full RN verification
under Node 22.23.2. Native Rust and generated JS agree
on 146 RPCs across all 13 commands and the BYO batch trace. The actual generated
JS rename/collision regression fails against the preceding artifact and passes
after regeneration.

Canonical Rust 1.98.0/x86_64 Linux generation comes from
[CI 39249070325](https://github.com/bota-dev/app-sdk/actions/runs/39249070325),
artifact `12183879672`, with input fingerprint
`6be481c47fd5d7e6966f9310af4a437a8779794ff6fcf4b6df01b69821427be2`.
The initial comparison intentionally detects stale committed JS; its generated
replacement is adopted unchanged, SHA-256
`cc460e110e4c47f94f15abaeb9364d340bcb8f42094c11a3752d26a053e1ebc3`.
Local provenance verification confirms the same inputs. No hash or generated
code is hand-edited. Fresh successor CI remains distinct from this source-bound
generation evidence. Local emulated Node/V8 could not complete generation;
the standard Linux CI result resolves that environment limitation.

Firmware functional commit `496895c` passes all five hosted checks: control,
marker-crypto, verify-gatt, resume and recovery. Target image compilation,
installation, physical tests, package publication and App qualification remain
open; this change performs no device operation or release.
