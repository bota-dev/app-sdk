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
