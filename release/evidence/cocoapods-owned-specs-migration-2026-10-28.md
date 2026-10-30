# Co-located CocoaPods Specs and signed Slack promotion

The owner's final October 28 decision stores Specs in the SDK repository and
uses the existing Bota Releases Slack service. This supersedes the separate
repository proposal recorded below. This source is prepared with activation
disabled; it does not announce a package release or deployed service.

## Current design review

| Requirement | Implementation/evidence | Status and remaining verification |
| --- | --- | --- |
| Same repository as SDK | `app-sdk/Specs/` holds 23 unchanged canonical specifications; source is `https://github.com/bota-dev/app-sdk.git`. | Candidate prepared; main bootstrap and clean default-main installation pending. |
| Immutable identity and append-only metadata | Original pod/version/archive URL/SHA-256; occupied entries require complete canonical equality. Strict bounded script-free JSON, path, symlink and full-history admission. | Behavioral fixtures plus explicit CLI validation in CI; no SDK version/runtime/archive change. |
| Actual Slack deployment request | Original tag preflight preserves five payloads plus release-inputs, registers one pending GitHub deployment, then a later job waits for Bota Releases approval. | Client/server tests and independent review; SDK policies remain disabled and no live request sent. |
| Exact signed approval | RS256 five-minute receipt binds repository, tag/object, source, original tag run/attempt, main CI run/attempt, inventory digest, request deployment and approval identity. Six artifact ID/name/digest snapshots are qualified. | Stale/replay/signature/attempt/artifact negative fixtures; live service/App access pending. |
| Preserve registry OIDC and approval before writes | Continue original tag-push run; no new publication dispatch. Refresh before registry/release writes, Specs push and delayed PR creation. | Original Dart OIDC/immutable inputs/occupied-version gates retained; live promotion unverified. |
| Use built-in token | SDK job `GITHUB_TOKEN` exposed as `GH_TOKEN`; same-repository Contents/Pull requests/Actions writes. No PAT, deploy key or cross-repository secret. | Actual Actions PR setting currently false; publication blocks until reviewed setup/readiness variable. |
| Independent GitHub source review | Stage one immutable index commit, explicitly dispatch exact-head Validate Specs/Dependency licenses/Scan, open PR, wait for independent merge and verify main bytes. Never approve/merge/direct-main/force. | Organization review/SAST rules remain. Slack deployment approval does not waive source review. |
| Normal named Apple/Flutter resolution | Isolated repos/caches; index ref/SHA, exact pod/version, lockfile/sandbox/payload, URL/SHA and real iOS release builds. | Prior separate-source builds pass; same-repository candidate and default-main proof are separate gates. |
| Disabled rollout and bounded recovery | SDK unit/client policy disabled, activation/readiness variables unset; historical environment protection retained. New manual recovery closes while Slack mode active. | No settings/IAM/App/cloud mutation. New run attempt requires all-job preflight and a new Slack decision. |
| Customer documentation | SDK migration/runbook/README and public guide use SDK source and explain approved mirrors/central-registry distinction. | Public docs `83e056a1bbe7e2d146727842343fb5a68328347c` passes MDX parse and exact Scan; integration/site deployment pending. |

The shared-infra service passes 206 service tests and 1,354 complete root tests
with zero skips in an isolated LF Git-blob snapshot using existing Python and
Node 22. Root types/lint, 84-package license gate and build pass. Windows Store
Python and CRLF fixture issues were corrected only in validation tooling, not
source. All 36 resource definitions and existing enabled release units remain
unchanged. Independent client/server/consumer/workflow review found no remaining
binding or permission issue after adding refresh before the delayed Specs PR.

SDK focused qualification passes 99 tests with one explicit Windows-only Ruby
skip; zero failures. The 33-package tooling license check, actionlint and actual
Bash syntax checks pass. Rust test/format execution is unavailable locally and
must pass on the hosted Linux source. All 12 runtime Git subtrees match base
`d774faa04aac43f1ac7cc257bc8f30db7005213f`; the 23 Specs match the earlier accepted
index byte-for-byte. New same-source hosted results remain a separate gate.

Historical SDK source `9e19bc878da5d6334f4c4b965f2b733b35e24473` passed both
clean consumers in [CI 40760142878](https://github.com/bota-dev/app-sdk/actions/runs/40760142878):
Apple beta.21 compiled, Flutter beta.21 produced an actual 23 MB `Runner.app`,
and pre/post-build source/archive proofs passed. These used the superseded
separate source and do not prove the co-located index. Beta.21 is the common
published Apple/Flutter version; beta.22 was absent from pub.dev. No artifact
is republished or rebuilt merely to satisfy migration qualification.

Before activation, require independent source integration and exact main
checks, then clean default-main consumers. Verify the existing Bota Releases
App's SDK access and deploy the service through CI with reviewed exact
source/ZIP authorization: the existing older authorization cannot authorize
these new bytes. Review actual Actions PR creation setup before setting
`SDK_SPECS_ACTIONS_PR_ENABLED`. Only then enable both SDK policies and
`SLACK_SDK_PRODUCTION_APPROVAL_ENABLED` and qualify a legitimate real Slack
request/approval/claim/refresh/publication. Keep historical release protection.
No new App, copied App private key, PAT or deploy key is needed.

Current synchronized version remains beta.23. This verification creates no tag,
registry release, app deployment, firmware install, recording or cloud-data
write. The earlier temporary unregistered SSH key cleanup was rejected by
automatic approval policy; no alternate deletion was attempted.

## Superseded separate-source investigation

The following dated record describes the earlier proposal only. Its separate
repository, writer-secret request and pending-build statuses are historical;
the current table and activation gates above take precedence.

The owner selected Bota/customer-maintained CocoaPods Specs on October 28,
2026. This changes the version index; it does not rename packages, rebuild
published archives, migrate SDK behavior or qualify a physical device.

### Historical requirements and review

| Requirement | Implementation and evidence | Status |
| --- | --- | --- |
| Keep CocoaPods available through an owned Git source | Public [Bota Specs](https://github.com/bota-dev/cocoapods-specs), initial commit `8f0c9b1cb81d344684f8afba89c3b3273e2ae9e8`; 23 canonical JSON specs copied from immutable official Specs commits. All 23 public `main` paths were read back with matching complete spec hashes and unchanged archive URLs/SHA-256. | Public index passes |
| Preserve identities and occupied versions | `BotaAppSDK` 2.0 beta.0, beta.1, beta.3–22 and historical `BotaAppleSDK` 1.2.0-beta.11. Exact canonical-byte equality is required for an occupied path; source metadata, scripts, symlinks, mutation and deletion have negative fixtures. No tag or archive was changed. | Source and index checks pass |
| Keep protected release and preserved inputs | Existing release approval/environment, annotated tag, Apple archive checksum and generated-podspec checks remain. Flutter verifies the preserved archive and full candidate-inventory projection before its real consumer build. | Source tests pass; hosted qualification required |
| Respect organization governance | Main retains organization rulesets `25790092` (independent PR approval, last-push approval, no deletion/force push) and `26008745` (Scan). Repository ruleset `26070297` additionally requires Validate Specs, License Gate and Scan from GitHub Actions. The publisher stages one exact commit, waits for checks, opens its PR and waits for independent approval/merge. It cannot approve, merge or directly update main. | Rules read back; publisher source qualification pending |
| Minimize publisher credentials | HTTPS credential helper for a token restricted to this index's Contents and Pull requests; authenticated REST requests use only the fixed GitHub API repository. No general user credential is persisted. Deploy keys are disabled by organization policy; no deploy key was registered. | Writer secret not configured; new-version publication not activated |
| Prove named Apple and Flutter consumers use the owned source | Empty CocoaPods repositories/cache and Flutter package cache; exact named native version, exclusive Bota source, indexed spec checksum, archive URL/SHA-256 and matching installed sandbox manifest/payload are checked. Both consumers compile actual iOS release targets. | Source fixtures pass; fresh macOS builds pending |
| Document customer migration accurately | [Migration guide](../../docs/migrations/cocoapods-owned-specs.md), release runbook, SDK README and public SDK guide. Enterprises must approve Bota Specs or their own immutable mirror; this is not central CocoaPods registration. | Source prepared; public-site deployment separate |

Initial index checks all passed: [Specs CI](https://github.com/bota-dev/cocoapods-specs/actions/runs/40753281229),
[License Gate](https://github.com/bota-dev/cocoapods-specs/actions/runs/40753281186)
and [Scan](https://github.com/bota-dev/cocoapods-specs/actions/runs/40753281295).
The repository is dependency-free; frozen install and 13 behavioral/index-history
fixtures passed locally and in Specs CI.

### Historical hosted findings and corrections

The first SDK qualification [run](https://github.com/bota-dev/app-sdk/actions/runs/40753481841)
passed all 172 release-tool tests on Linux. Its Rust release-readiness fixture
still required Trunk publication; the guard now checks protected owned-index
publication while retaining immutable-input checks.

The clean beta.22 Apple install and historical 1.2.0-beta.11 install both
resolved and downloaded the correct named pod from Bota Specs. Their validator
then failed because it assumed every installed registry pod has a `Local
Podspecs` copy. The correction uses pinned CocoaPods Source/Sandbox APIs, the
complete installed `Manifest.lock`, the selected indexed JSON spec and actual
sandbox payload. Optional local metadata must still match. Regression tests
first reproduced the invalid assumption and missing/stale-manifest admission.
This correction requires fresh macOS compilation; the earlier successful
download is not a successful build claim.

Source `ba0f6988` subsequently compiled the clean beta.22 Apple application
through Bota Specs in [run 40755373668](https://github.com/bota-dev/app-sdk/actions/runs/40755373668).
The Flutter consumer correctly refused beta.22 because that version was not
published on pub.dev. A fresh authoritative pub.dev API read found beta.21
was the latest available Flutter package. Public migration qualification now
selects beta.21 for both consumers, preserving exact matching native/plugin
versions. Future release-candidate qualification still uses the exact preserved
candidate archive and matching owned-index native version. No package is
published or rebuilt to satisfy this source-migration gate.

The beta.21 Flutter attempt then exposed a consumer-script Ruby error before
native dependency installation: the in-place YAML edit invoked `sub!` without
its string receiver. It now edits `$_.sub!`; a regression executes the actual
embedded Ruby snippet against valid and missing-marker YAML on Linux/macOS.
Windows without Ruby explicitly skips this one executed-tool fixture. Actual
Flutter compilation remains required after this correction.

Source `cf340355` then compiled the beta.21 Flutter iOS application to a 23 MB
`Runner.app` in run `40757539789`, with the pre-build Bota source/archive proof
passing. Its post-build gate rejected the CocoaPods client metadata; that log
did not expose the actual changed/missing value. Flutter's pinned tool invokes
plain `pod`, so the consumer now provides a task-local wrapper around the
already selected executable and `_1.16.2_` gem selector for both Flutter and
direct calls. An executed Bash regression verifies the actual setup, spaced
paths/arguments and preserved gem environment. The exact client/source/checksum
gates remain; post-build diagnostics now report only a bounded client value.
Fresh complete qualification is still required after this correction.

The first clean clone used the repository's bootstrap default branch. The
default is now explicitly `main`, verified through both repository metadata
and Git's symbolic remote HEAD.

The protected release publisher checks for its configured Specs writer before
any registry publication. This prevents a known missing credential from starting
another partial synchronized release; it does not prove token permissions,
expiry or successful independent Specs approval.

### Historical remaining gates

- Successful exact-source hosted CI, including both clean iOS consumer builds.
- Configure and validate `BOTA_COCOAPODS_SPECS_TOKEN` in the SDK's protected
  `release` environment with only this index's Contents/Pull requests write
  permissions, including organization approval and expiry/rotation management.
- Integrate reviewed SDK/index-documentation/public-documentation changes
  under the current independent-review rules. The owner's older direct-main
  delivery preference does not waive server-enforced review.
- Qualify a future protected new-version publication and independent Specs PR
  merge. Existing beta.22 availability does not exercise that write path.

No new SDK release, app deployment, firmware installation, recording, cloud
write or retained-upload retry is part of this migration verification.
