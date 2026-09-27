# Web actions and client-presence integration

Status: source integration, not publication or hardware acceptance (2026-09-27).

This integrates the client-presence and Web action branch with main `dd8c6e5`.
Web uses the same Rust upload-context codec as native platforms. The manifest,
generated protocol and firmware wire format are unchanged from main.

## Design comparison

| Requirement | Evidence | Status |
| --- | --- | --- |
| Fresh nonce, application-owned authorization HTTP | Web control/provider and upload-context tests; no SDK API client | matched in host tests |
| One connection owner through v2 preparation and transfer | Shared runtime exclusive preparation and synchronous one-shot workflow handoff; deferred-provider competition/disconnect regressions | matched in host tests |
| Exact successor before resetting progress | Shared Rust authorization decoder; owner, recording, ciphertext, policy and replacement-flag checks before atomic IndexedDB replacement | matched in host tests |
| Device signature authority and receipt-before-confirm | Shape checks do not verify signatures; existing receipt/completion workflow retained | matched by source and host tests; physical behavior unverified |
| Passive, minimal client metadata | Connection-owned random session/sequence and generated package/version across Web/native/RN/Flutter; no SDK heartbeat HTTP or phone identifier | matched by source and targeted platform tests |
| No stale Apple connection after presence lookup | Cancellation/detach during suspended identity lookup both failed before fix and pass after it; full Swift suite passes | matched in host tests |
| External published package and normal CI | Portal must pin a later synchronized release; beta.3 is already tagged and is not modified | pending |
| Actual browser recording, stop, upload and deletion | Requires the supervised physical-device runbook and exact published artifact | unverified |

Review found three important issues: Apple late connection publication, unchecked
successor authorization, and Web preparation releasing connection ownership.
Each was reproduced by a failing regression before its fix. No critical or minor
findings were reported. Backend recovery and Portal scope/routing are outside
this SDK review; their separate evidence remains required. Full command-ID-bound
firmware authorization is not claimed by this compatibility integration.

Local verification includes Rust workspace tests and clippy, generated protocol,
Web typecheck/unit/packed Chromium tests, React Native verification, Android unit
tests, and Apple package tests. Apple physical tests remain skipped. Flutter's
fresh consumers, exact-revision CI, release inventory and protected publication
are separate release gates; passing these local checks does not substitute for
them.

The historical beta.2 manifest is preserved from main. New release artifact
hashes must be generated for a new version, never copied into an occupied tag.
