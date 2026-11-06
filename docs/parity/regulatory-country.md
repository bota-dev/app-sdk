# Signed regulatory country delivery review

Status: source implementation; publication and external BES qualification remain separate.
Authority: [protocol](../../protocol/regulatory-country-v1.md) and
[design PR #144](https://github.com/bota-dev/internal-docs/pull/144).

| Requirement | Implementation and evidence | Status / remaining check |
| --- | --- | --- |
| Keep two-stage binding and token wire format | Provisioning still installs BOTATOK1 before App confirm; Rust, RN and Web reject plaintext before credential writes. | Source tests pass; qualify actual encrypted-capable consumers before rollout. |
| Readable signed country; no independent HPKE | B07A000C manifest, Rust bounded BOTAREG1/BOTARAK1 codecs, identical public-key vector in API/SDK/design. SDK only transports evidence; firmware/backend authenticate signatures. | Source contract aligned; BES verifier and driver implementation required. |
| Minimum-MTU delivery and lost notifications | Generated-JS host subscribes before writes, fragments at MTU23 and reads complete receipts after notification loss. | Actual generated-core transport tests; target BLE long-read qualification pending. |
| Owner isolation and cleanup | Captured connection/scope on each IO; matched nonce/config/revision/generation; clear pending codec state and join subscription removal. | Source cancellation and stale-receipt tests; hardware reconnect/power-loss checks pending. |
| Keep confirmed ownership on application failure | Backend confirms atomically; App saves binding before independent configuration delivery/ACK. SDK does not provision another token for retry. | Companion API/App integration tests; final published-package integration pending. |
| Preserve existing radio/transfer formats | QR parsing, Wi-Fi v3 authorization and recording transfer frames are unchanged. Regulatory state gates readiness independently. | Existing RN/Web regressions and native/JS parity; no RF or physical fast-transfer acceptance claimed. |
| Only enable qualified deployments | Backend global/project admission off and empty approved catalog; current App package pins retained. | Publish/qualify SDK, adopt exact registry version in Apps, deploy One proxy, qualify BES and RF artifacts, then enable dev pilot. |

The runtime was regenerated with the required Linux x86_64 Rust 1.98.0 and
locked Binaryen 132.0.0 generator. Local Node disabled Wasm tier-up/liftoff to
avoid an emulation crash; generator inputs and transformations were unchanged.
Source provenance passes, and native Rust/generated JavaScript agree on 162 RPCs.
Rust country/provisioning tests pass (10), JS bridge tests pass (73), Web tests
pass (402) with typecheck, all 684 RN tests pass, and package/license/tooling
checks pass. Two local-Wi-Fi cases failed on the first combined run, then all
19 passed in isolation and the full RN rerun passed; hosted confirmation remains
required. Package publication,
native adapters without the additive capability, and physical acceptance remain
separate. No package version or artifact checksum was invented.

The signed vector belongs in `protocol/vectors`, outside native fixture suites.
After correcting that test reference, exact-source Linux CI run `42169307061`
at head `9309890e` rebuilt the runtime. Adopted `core.expected.ts` unmodified
from artifact `13480088497`; SHA-256 is
`a4e28322d875b92cfb050365215f5d91485f65992f694a8f4231ff480c1ab1f8`.
The executable bytes are identical; only generated source provenance changed
to `2e3dd62ce61f9eb37ec29528fef5a285f58642844c9f5d911712e1e61f97fde5`.
Local fixture-contract, Apple/Android fixture-resource and 16 affected runtime
checks pass. That CI's Rust/tooling lane passes; the new final commit still needs
its own hosted checks. No generation check was disabled or hand-edited.

An extended Demo probe also reproduces three OTA subscription settlement failures
against both its feature branch and original main using the existing published
SDK. The matching successor package must be qualified and adopted before release;
country source tests do not establish that package acceptance.

## Nonce dataflow and CodeQL follow-up

The CodeQL check on `17fb6de0` reported six fixed-nonce test inputs and one
zero-initialized decode buffer. The buffer was fully overwritten from the device
challenge before use; it was not a nonce generator. Decode directly into a
fallible 16-byte result instead, and read the deterministic test nonce from the
shared vector's independent `nonceHex` field. The negative context test changes
one byte of that nonce. No alert suppression or security-check exclusion is used.

| Requirement | Evidence | Scope |
| --- | --- | --- |
| Preserve the complete device challenge | Generated-code regression varies each of the 16 input bytes and checks exact document reassembly with a mixed-byte nonce. | Transport validation; firmware/backend still authenticate the document. |
| Reject malformed, stale and all-zero nonce inputs | Short, long, uppercase, non-hex, non-ASCII, mismatched and all-zero inputs refuse; failure clears prepared receipt state. | Original protocol and error behavior retained. |
| Preserve binding, token and country authority | This change only clarifies nonce decoding and fixture provenance; project-only country source, two-stage binding and BOTATOK1 remain unchanged. | No release, environment or firmware operation. |

The corrected Rust requires canonical Linux JavaScript regeneration and fresh
exact-head CI, including CodeQL, before merge. Test results and generated artifact
identity for this follow-up are recorded in PR #84.
