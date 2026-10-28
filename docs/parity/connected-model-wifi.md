# Connected model and WiFi capability

October 28, 2026. This source correction applies to the original React Native
generated-JS runtime used on Android and iOS. Publication and physical acceptance
remain separate from the tests below.

## Contract

- Read the full serial and model from the connected GATT device. Normalize known
  Pin, Pin 4G and Note GATT aliases to `bota_pin`, `bota_pin_4g`, `bota_note`.
  Historical spaced and hyphenated aliases are accepted only at this boundary;
  firmware should emit canonical underscore values. Advertising labels never
  authorize an identity or a model. `BOTA_DEV`, unknown values and Pin Pro are
  preserved, never guessed as Pin or conflated with Pin 4G.
- Restore the existing optional `ConnectedDevice.capabilities` object. Its
  `wifiUpload` value comes from the current local connection's discovered
  `SERVICE_BOTA_WIFI_CONFIG`, independently of the model string. Reconnect and
  OTA recovery repeat inspection instead of reusing a previous capability.
- The additive optional `JsBlePort.hasService` primitive inspects OS discovery;
  the BLE PLX implementation uses `servicesForDevice`, checks cancellation and
  the captured physical generation, and normalizes UUID case/short forms.
  Custom ports without inspection retain conservative `wifiUpload: false`.
  An inspection error fails connection adoption instead of advertising support.
- WiFi grant, credential encoding, result validation, serial checks and scoped
  ownership remain unchanged and owned by the existing shared runtime.

## Cross-repository acceptance checklist

| Requirement | Implementation / evidence | Status |
| --- | --- | --- |
| Connected identity overrides scan-time Pin fallback | `deviceControls` normalization; Android/iOS real-generated-runtime fixtures | Source passed |
| WiFi support reflects current discovery, including reconnect | BLE PLX captured-generation tests; public client connection/reconnect and ordered grant/credential/result fixtures | Source passed |
| Missing service, unknown identity and stale discovery remain safe | Negative fixtures; existing serial/ownership regressions | Source passed |
| Demo registers connected identity and retains scan enrichment | Companion Demo model/WiFi PR; real screen, hook and API regression matrix | Companion source passed |
| Existing conflicting cloud model is not silently overwritten | Companion Demo refuses binding before token issuance; administrator verifies historical records separately | Companion source passed |
| One preserves connected Note aliases and scan freshness | Companion One real pairing screen, model admission and React/Zustand regressions; Pin 4G/Pro are never registered as ordinary Pin | Companion source passed |
| One's composite registration validates identity before binding | Actual Lambda/client tests for exact serial and stored model; conflicts cannot fall through to bind; older provisional mismatches attempt exact abort | Companion source passed; backend deployment pending |
| Published SDK and both app dependency adoptions | Release a new immutable SDK version, then update One and Demo to the same registry version/lock; current One beta.19 and Demo beta.22 lack this correction | Pending release and both adoptions |
| Android and iOS app consumption | Packed SDK with real One and Demo WiFi hooks/wrappers and simulated BLE PLX services; platform bundle results are recorded in each companion | Packed flows passed locally; release pins pending |
| Physical Note pairing, reconnect and WiFi association | Check the exact serial, service discovery, fresh cloud model and actual network status on both phones | Not run |

## Verification and design review

The relevant authoritative contracts are `FIRMWARE_PROTOCOL.md`, the frozen
React Native `ConnectedDevice` API and `docs/parity/ble-advertising-name.md`.
The correction preserves the public API and OS-port version 1, introduces only
an optional discovery primitive, and does not change any wire packet or weaken
binding/model comparison. Manual requirement-to-evidence review is used because
the compound-engineering skill is unavailable in this environment.

Local RN build, strict types, package metadata, Codegen and license checks pass.
All 599 RN tests pass, including Android/iOS simulated transport paths. These
are source/contract results, not Bluetooth-radio or network-association proof.
The root `npm run check` could not run because this host has no Cargo binary.
The PR's Rust/tooling job subsequently passed for source `ff5f9c42`; native-binary
checks remain separate. No Rust or native adapter source is changed here.

The companion Demo additionally passed its 117 migration tests, two packed
runtime WiFi tests, strict types, license checks and Android/iOS Expo exports.
Its committed dependency remains the existing public release; the tested local
archive is not a publication. See the companion review for archive qualification
and dependency-resolution limits.

One's companion adds 125 passing migration tests, two packed runtime WiFi tests,
backend/app strict types, root/app lint, 28 data-access checks and its license
gate. Its registration Lambda is a composite create/lookup/bind operation, so
the model check must run there before token preparation, in addition to client
checks. One's existing beta.19 also lacks the method required by its current
envelope-pairing guard. Both apps must adopt the same corrected release and pass
their exact native/physical checks before this checklist is complete.

## Firmware integration checklist

1. Initialize a Note with manufacturing `model_code = 2` and the correct full
   serial. Return `bota_note` from Device Information Model Number (`0x2A24`)
   and that serial from `0x2A25`. Keep manufacturing, advertising and GATT
   identities consistent; do not derive identity from a display name.
2. For structured scan classification, emit the existing 14-byte manufacturer
   payload: company ID, MAC, version 1, model code, final four serial characters.
   Legacy MAC-only advertisements still require connected GATT identification.
3. A WiFi-enabled build must expose service `B07A0006-0000-1000-8000-00805F9B34FB`
   and its existing grant (`0001`), credential/result (`0002`), status (`0003`)
   and scan (`0004`) characteristics. Process authorization before credentials
   and report both configuration result and actual association status.
4. Verify on Android and iOS: scan, connect, bind/confirm, restart/reconnect,
   configure WiFi and confirm connected status. Changing the display name or
   GATT model cannot repair an already incorrect server model; report that
   mismatch for a separate verified data correction.

No new firmware wire field, credential format or key derivation is required by
this source fix. Service presence alone does not prove that a specific firmware
build can associate with a real network.
