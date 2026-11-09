# SignedBlob discovery failures before BEGIN

The November 9 dev App log for an unimplemented country transport reports a
missing SignedBlob characteristic, followed by ordinary controls refusing with
`cleanup_incomplete`. The host reproduces a concrete failure path: it marks BEGIN
as attempted before the native write, then tries ABORT even when BLE PLX could
not resolve the characteristic. A second missing-characteristic error poisons
the shared executor although no device-side transaction was created. The log
does not itself expose the exact native callback ordering or cleanup cause.

## Correction and boundaries

BLE PLX service-not-found (302) and characteristic-not-found (404) are mapped to
fixed host codes. Only a write refusal for these local discovery errors carries
`notSubmitted: true`. Native cancellation failure remains `cleanup_incomplete`
and must not acquire that marker. Reads and monitor errors never claim write
submission evidence. No message-text matching is used.

The SignedBlob exchange skips ABORT only when its first BEGIN write is explicitly
unsubmitted with one of those discovery codes. It still awaits unsubscribe.
Missing endpoints after a previous frame, unknown write outcomes, cancellation,
timeouts and real cleanup failures retain the existing ABORT/fencing policy.
This is a transport ownership correction; Rust framing, RESULT validation,
credentials, native ABI and firmware protocol are unchanged.

Country application translates a missing endpoint into
`country_configuration_unsupported` only when cleanup has not poisoned the
owner. It never returns a successful country observation or permits a WiFi
credential write. A missing endpoint in this connection is not proof that all
firmware versions lack the feature; firmware updates/GATT discovery and actual
kind-8 acceptance still require device testing. Nonzero firmware RESULT values
retain their original protocol status, including unknown values.

## Design and acceptance review

| Requirement | Implementation and verification | Remaining check |
| --- | --- | --- |
| Unsubmitted BEGIN cannot poison later controls through a redundant ABORT | Actual BLE PLX host adapter plus generated country codec regression fails on main with two writes instead of one; patched source permits the next country control | Android/iOS physical firmware without the characteristic |
| Uncertain device-side state remains fenced | Unknown first-write failure, later missing endpoint and unsubscribe failure regressions preserve refusal | Device disconnect/cancellation timing |
| Errors distinguish unavailable firmware from cleanup failure | Typed country error; companion Demo supplies fixed actionable messages | Qualified SDK publication/adoption and combined App build |
| No new protocol or authorization bypass | Existing SignedBlob kind 8, signed document and exact result checks retained | Real board accepts/applies country before WiFi setup |

Run the RN build, full RN tests and typecheck, plus the generated-source
provenance and package checks. This source correction does not publish an SDK,
deploy a backend, build an APK or establish physical acceptance. Release the
reviewed SDK before adopting its exact published package in Demo; local package
qualification remains separate from registry adoption.

Local verification on November 9: `npm run verify` in `frameworks/react-native`
passes package/Codegen/type/build checks, **712 RN tests** and the license gate
(412 packages). `node tools/react-native/generate-js-core.mjs --provenance-only`
passes with the unchanged generated core. Five companion Demo tests run against
the actual local npm archive/public runtime, including a successful status read
after missing country transport and a later successful country application.
The archive's source and executable files match this checkout. Hosted CI,
registry publication and physical tests remain separate gates.
