# Owned CocoaPods Specs migration

The owner selected Bota/customer-maintained CocoaPods Specs on October 28,
2026. This changes the version index; it does not rename packages, rebuild
published archives, migrate SDK behavior or qualify a physical device.

## Requirements and review

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

## Hosted findings and corrections

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

The first clean clone used the repository's bootstrap default branch. The
default is now explicitly `main`, verified through both repository metadata
and Git's symbolic remote HEAD.

The protected release publisher checks for its configured Specs writer before
any registry publication. This prevents a known missing credential from starting
another partial synchronized release; it does not prove token permissions,
expiry or successful independent Specs approval.

## Remaining gates

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
