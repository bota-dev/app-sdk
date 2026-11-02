# Secure WiFi static-analysis review

This review covers SDK PR #73 at `059e686a9146bccd878bde0ff99e150dcde29479`
and its security-check follow-up. The authoritative contract remains
[WiFi provisioning v2](../../protocol/wifi-config-v2.md); the PR owns the single
cross-repository completion checklist.

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
