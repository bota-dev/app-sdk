# Factory-reset authorization correction — October 6, 2026

Remove-only deprovision (`0x05`) preserves physical recordings and settings.
Destructive reset (`0x06`) requires a separate authorization; no SDK or firmware
path may substitute deprovision permission.

The reset provider receives the exact serial, device nonce, durable backend
command ID and binding generation. Request `/devices/:id/factory-reset-grant`
under the public API or Dashboard project path. The issuer locks the current
device binding and validates the exact pending/delivered reset command before
signing; a stale command/generation, foreign device or elapsed command cannot
obtain authorization. Missing generations require recovery of the exact command,
not a default generation.

The reset-only envelope is 179 bytes: a four-byte big-endian generation prefix,
65-byte HPKE P-256 encapsulation, and 110-byte authenticated ciphertext. Its
signed plaintext is version `2`, exact scope `0x10`, nonce (16 bytes), issued and
expiry timestamps (u32BE), and generation (u32BE), followed by the 64-byte backend
signature. The prefix repeats the signed generation. The SDK rejects 171-byte
deprovision grants and a prefix inconsistent with the host's exact generation.
Rust sends `[0x06, generation(u32BE)]` only after delivering this envelope.

Firmware checks HPKE recipient identity, signature, exact action, live nonce,
generation agreement and the bounded expiry before installing reset permission.
It consumes permission before scheduling the wipe. Every provisioning-storage
mutation clears installed permission and rotates the nonce before writing flash,
so grants from a previous physical binding cannot survive credential replacement,
including a failed write/rollback. The issuer checks the cloud generation;
firmware fences the installed binding with its credential-transition nonce and
requires the signed generation on dispatch. It does not infer a cloud generation
from an application-supplied numeric field alone.

The durable wipe, application result persistence, receipt and exact backend ACK
ordering remain separate from authorization. Existing receipt recovery never
resends an authorization or destructive opcode. Cloud recordings and lifetime
manufacturing identity remain outside the reset deletion boundary.

## Verification

| Requirement | Evidence | Status |
|---|---|---|
| Dedicated action/device/nonce/generation/expiry | Backend HPKE roundtrip/signature tests and dedicated service/route tests | Matched in source/host tests |
| Reject legacy grants and generation mismatch before native delivery | React Native device-client test; native provider validation; Rust rejection regression | JS and hosted Rust verified; native checks pending |
| Preserve durable result and receipt recovery | Existing factory-reset workflow tests and Demo reset-finalization suite | Host/source verified; physical acceptance pending |

A new native SDK release and app binaries, backend rollout and firmware update
are required for device acceptance. Publishing a JavaScript bundle against the
old 171-byte Rust core cannot implement this correction. Native publication,
rollout and destructive hardware tests are separate gates.
