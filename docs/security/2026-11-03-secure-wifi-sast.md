# Secure WiFi static-analysis review

This review covers SDK PR #73 at `059e686a9146bccd878bde0ff99e150dcde29479`
and its security-check follow-up, plus the PR #75 v3 test-vector triage below.
The authoritative contract is [WiFi provisioning v2/v3](../../protocol/wifi-config-v2.md).
The respective PR
links the single cross-repository completion checklist.

## Findings and evidence

| Finding | Review and disposition |
| --- | --- |
| Semgrep reviewed-source digest mismatch | `bindings/device-sdk-ffi/src/protocol.rs` changes only the existing owned packet regression to expect `UnsupportedOperation` / `Provision` for retired plaintext WiFi encoding. The packet storage, encode invocation and annotated unsafe boundaries are unchanged. Update its digest in the workflow and review ledger together; retain all 85 dispositions and the exact-source gate. |
| CodeQL alerts 23 and 24, zero-initialized `tx` and `rx` | False positives: these are HKDF output buffers, not constant cipher keys. `WifiProvisioning::new` rejects an all-zero operation key, derives both complete 44-byte buffers from the caller-supplied key and SHA-256 of the complete grant, and returns a session only after both expansions succeed. Distinct app/device info values separate the directions. The JS binding decodes the current grant's `key_base64`; no production fixture is imported. |
| CodeQL alerts 13 through 22, credential literals in `tests/wifi_provisioning.rs` | Used only in integration tests: deterministic shared-vector credentials and intentionally invalid/empty inputs. They are not deployment credentials. The shared vector explicitly identifies its keys as synthetic. Retain deterministic interoperability and malformed-input coverage. |

Alert dispositions are per finding with an audit comment, using GitHub's
[documented triage mechanism](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/triage-alerts-in-pull-requests).
No scanner rule, path, severity, required check or generated-runtime coverage is
removed. No plaintext fallback or replacement crypto implementation is added.

## Verification and conformance

The added generated-runtime regression changes each of the 32 operation-key
bytes independently, then changes the final grant byte. Each case changes the
credential ciphertext and rejects the original authenticated device receipt
through the actual JavaScript-to-Rust binding. It also rejects an all-zero key.
The existing shared backend/firmware vector still matches exactly; tamper,
replay and legacy rejection remain. Production Rust and generated JavaScript
bytes are unchanged.

| Requirement | Verification | Status |
| --- | --- | --- |
| Native crypto interoperability and rejection | `cargo test -p bota-device-sdk-core --test wifi_provisioning` | 3 tests passed |
| Operation-derived keys in both directions through the committed runtime | `node --test frameworks/react-native/src/jsHost/__tests__/wifiProvisioning.test.mjs` | 9 tests passed |
| Existing FFI ownership and legacy refusal | `cargo test -p bota-device-sdk-ffi` | Passed |
| Exact reviewed-source coverage | Execute the workflow's annotation validation against all 16 pinned files and the 85-entry ledger | Passed |
| Formatting | `cargo fmt --all -- --check` | Passed |
| Hosted scan closure and complete current-head CI | PR checks and per-alert dispositions | Tracked on the PR; separate from local verification |
| SDK publication, App adoption, target image and physical BLE/storage checks | Shared PR checklist | Pending; not established by host tests |

The shared compound-engineering skill is unavailable locally. This direct
requirement-to-evidence review follows the fallback in `CONTRIBUTING.md`.

## PR #75: synthetic v3 credential finding

[CodeQL alert 25](https://github.com/bota-dev/app-sdk/security/code-scanning/25)
flags the password literal in
[`v3_uses_explicit_binding_proof_profile_and_preserves_v2`](https://github.com/bota-dev/app-sdk/blob/3332e1757a981d97d438e5ae09013dafc7475d60/core/device-sdk-core/tests/wifi_provisioning.rs#L107).
At reviewed source `3332e1757a981d97d438e5ae09013dafc7475d60`, this is a Rust
integration test comparing encrypted credentials against the public synthetic
[v3 vector](../../protocol/wifi-config-v3.vector.json). The fixture identifies
its keys as synthetic and unsuitable for deployed devices. CodeQL also classifies
the finding as `test`. The fixed SSID/password are test inputs, not deployment
credentials; preserving them retains exact backend/SDK/firmware interoperability.

Production `WifiProvisioning::seal_credentials` receives the caller's SSID and
password; `WifiProvisioning::new` derives direction-specific keys from the current
operation key and complete grant. The JS production binding receives the current
grant's key. It does not import this fixture. Disposition: `used in tests`, with
this evidence recorded on alert 25. No source obfuscation, scanner suppression,
workflow change, production-code change or generated-artifact change is needed.

Focused verification on that source:

| Requirement | Verification | Status |
| --- | --- | --- |
| Native v2/v3 vector interoperability and refusal | `cargo test --locked -p bota-device-sdk-core --test wifi_provisioning` | 4 passed, no skips |
| Actual generated runtime and BLE host encryption, v3 negotiation and refusal | `node --test frameworks/react-native/src/jsHost/__tests__/wifiProvisioning.test.mjs` | 11 passed, no skips |
| Hosted alert closure and exact-head checks | Read alert 25 and commit check runs, including the independent `CodeQL` result check | Recorded on PR #75 separately from local tests; successful analysis workflows alone are insufficient |

This follow-up changes review evidence only. Package publication, installed-App
adoption and physical firmware qualification retain their existing release gates.
