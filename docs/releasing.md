# Current publication repair: 2.0.0-beta.7

Beta.6 published Apple, Android and both npm packages; their public consumers
passed. [Release 36510538351](https://github.com/bota-dev/app-sdk/actions/runs/36510538351)
failed before Flutter upload because locked dependency resolution entered the
example, whose lockfile is deliberately excluded from the archive. Do not retry
that deterministic failure or move its tag. Beta.7 synchronizes the family with
pub get --enforce-lockfile --no-example and a shared extracted-archive CI dry-run
and publisher. Runtime behavior is unchanged; beta.6 mobile binaries remain valid.
See [beta.7 preflight](../release/evidence/2.0.0-beta.7-preflight.md).

# Releasing The Bota App SDK

## Current Candidate

`2.0.0-beta.6` is the requested mobile parity release: standalone-compatible
presence, fresh-session observation, scoped upload recovery helpers and the
latest maintenance baseline. See [beta.6 preflight](../release/evidence/2.0.0-beta.6-preflight.md).
The existing single approval and exact CI-artifact promotion procedure applies.
New native consumer binaries are required. No standalone package deprecation is
part of this publication; that follows consumer rollout.

### Previous candidate: beta.5

`2.0.0-beta.5` is the owner-approved next synchronized candidate. It retains
beta.4's SDK behavior and uses the single release workflow to promote exact
main-CI artifacts, including Flutter's preserved lock and evidence. See
[beta.5 preflight](../release/evidence/2.0.0-beta.5-preflight.md). Publication
requires final main CI and License Gate, verified Apple checksums, the annotated
candidate run/inventory, and the protected approval. No beta.5 publication or
additional physical acceptance is established by metadata preparation.

### Previous candidate: beta.4

`2.0.0-beta.4` prepares Web Bluetooth actions, passive client presence, and the
reviewed connection/recovery guards on top of the beta.3 integration. See
[Web integration evidence](testing/web-actions-integration.md) and
[beta.4 preflight](../release/evidence/2.0.0-beta.4-preflight.md). Its immutable
tag is partially published: SwiftPM, CocoaPods, Maven and both npm packages
are public. CocoaPods CDN readiness and the retried Flutter Android/iOS builds
passed. Run `36343414157` attempt 7 then failed its rebuilt Flutter evidence
comparison with the annotation-bound inventory; protected controller
`36479125467` stopped. The retry resolved `built_collection 5.1.2` instead
of the original lock's `5.1.1`; the package archive itself is unchanged.
Flutter publication remains pending; do not retry that
immutable build blindly or substitute a newer main commit's candidate.
It is not a synchronized release or cross-platform physical acceptance. See
[beta.4 recovery](#immutable-beta4-recovery-after-the-approval-cutover). Exact
main CI, generated candidate inventory, and protected publication remain required.
The existing `v2.0.0-beta.3` tag and its release remain untouched.

### Previous candidate: beta.3

`2.0.0-beta.3` prepares the maintenance-parity and native encrypted-upload-v2
integration, Android reconnect/catalog fixes, and legacy transfer burst/final
ACK corrections. It also includes the preceding Web selected-device serial
discovery. All five SDK versions remain synchronized. See the
[beta.3 preflight](../release/evidence/2.0.0-beta.3-preflight.md) for exact scope,
verification, and hardware limits. The owner requested publication after one
successful Android BLE encrypted batch upload and cloud playback. This is not
cross-platform hardware acceptance; v2 compatibility flags remain disabled.
Publication requires green exact main CI, its five-platform candidate inventory,
and the protected release workflow. Advance only npm `beta`; preserve `latest`,
historical packages, and immutable tags.

`v2.0.0-beta.2` is occupied and partially published. Run `36082976764` published
and verified Maven and exposed the GitHub prerelease, then stopped when the
public Apple archive URL returned HTTP 404. npm, CocoaPods and Flutter steps
did not complete. Do not move that tag or describe it as a synchronized release.

## Current Release

`2.0.0-beta.1` is the published synchronized beta. It includes the
Flutter Android SDK-path fix and the release workflow corrections made after
beta.0. The owner authorized normal CI and protected publication for this
version. Local [preflight](../release/evidence/2.0.0-beta.1-preflight.md) and exact
main/tag CI gates passed. Apple SwiftPM/CocoaPods, Android Maven, and both npm
packages and Flutter are published. Both protected workflows passed, including
actual RN/Web and Flutter OIDC uploads, public native consumers, the ordered
Flutter Android/iOS build gates, and exact public archive verification.
See the [publication record](../release/evidence/2.0.0-beta.1-publication.md)
for exact checks and recovery attempts.
Only the new npm `beta` tags may advance; `latest` stays at `2.0.0-beta.0`, and
all legacy packages and tags remain unchanged. Hardware acceptance remains
NOT RUN and application rollout is separate.

## Package Name Migration

Current tooling selects publication identities from the verified release
version. Central recovery preserves the signed bundle and deployment UUID;
it never relabels an old deployment. npm publication uses
`tools/release/publish-npm.mjs`: only a registry 404 authorizes a new upload,
the exact tarball identity/hash is checked, `beta` is explicit, `latest` must
not move, and the old package's dist-tags must remain unchanged when publishing
a renamed package. Registry authentication and transport failures stop the run.

Registry acceptance is not consumer readiness. npm verifies the exact version
first, then polls package-level `beta` independently (up to 30 checks, ten
seconds apart). Every tag check still rejects a changed `latest`; checksum and
historical-tag protections remain mandatory. The wait never republishes bytes.

Before a clean public CocoaPods install, `tools/release/wait-cocoapods.mjs`
requires both the exact version in the CDN's sharded version index and the
matching public podspec. A successful Trunk publication or direct spec URL alone
is insufficient. It checks up to 61 times, thirty seconds apart, with bounded
HTTP requests. Only absent index entries/specs are treated as propagation lag;
authentication, server, network, malformed-spec and identity failures stop the
gate. The consumer still uses the normal CDN and `pod install --repo-update`,
with no local spec override. Exhaustion requires retrying verification later,
not republishing. These tooling changes apply to subsequent source revisions;
immutable beta.3 continues to use its tagged scripts.

Readiness review: `publish-npm.test.mjs` covers delayed tags on both fresh
publication and occupied-version recovery, bounded exhaustion, and immediate
`latest` drift rejection. `wait-cocoapods.test.mjs` covers independently delayed
index/spec visibility, exact identity, bounded exhaustion, hard failures, and
consumer ordering. These checks match the existing no-republish/no-override
release requirements. They do not establish publication or public consumer
build success; the protected workflow must still supply that evidence. The
Rust `release_readiness` structural gate also checks the bounded npm tag guard;
run `cargo test -p xtask --test release_readiness` alongside the Node tests when
changing the release scripts.

The renamed `2.0.0-beta.0` candidate passed main CI at
`dd672a5865ba460ca3e97420e97461eb096dfb4f`. Its immutable tag is pushed and
all five packages are public and verified: Android Central, Apple
SwiftPM/CocoaPods, both renamed npm packages, and Flutter pub.dev. Release run
`35971649362` resumed from its preserved signed Central inputs without another
native/npm upload. After the CocoaPods CDN index propagated, clean public
SwiftPM/CocoaPods and API 26/35 Maven consumers passed. The ordered Flutter
candidate matched the tagged inventory and passed fresh Android/iOS release
builds. The owner published it once; public verification matched all 57 files.
The separate Flutter workflow verified the occupied version and skipped upload.

The final evidence-attachment job failed because `gh` ran without a checkout
or explicit repository. Its verified artifacts were attached manually without
replacing existing assets; the tag remains immutable and its run retains that
failure. Current tooling passes `--repo "$GITHUB_REPOSITORY"` and publishes the
Flutter manifest as `flutter-release-manifest.json`, preserving the existing
native `release-manifest.json`. See the
[publication record](../release/evidence/2.0.0-beta.0-publication.md).
React Native and Web trusted publishers and Flutter's restricted GitHub
publisher were saved and verified for beta.0. Beta.1 subsequently proved all
three automated OIDC uploads without an interactive login or token fallback.
Hardware acceptance remains NOT RUN; Demo and Bota One were not upgraded.

Post-publication consumer checks found a Flutter Android installation issue:
published beta.0 needs `BOTA_FLUTTER_HOME` set to the Flutter SDK directory.
Main fixes normal `local.properties` resolution and tests without that override;
the immutable beta.0 archive still needs that workaround. Published beta.1
contains the fix. See [beta.0 consumer evidence](../release/evidence/2.0.0-beta.0-public-consumers.md)
and the current publication record above.

Release tooling distinguishes historical major-0/1 identifiers from the
approved major-2 App SDK identifiers. Manifest version 2 is retained because
the evidence fields do not change; its package matrix is selected by the
validated SDK major. Major 2 cannot use manifest version 1 to bypass identity
checks. Historical manifests and tagged-source layouts remain supported by
current recovery tooling.

Major-2 releases remain beta-only. The source migration and publication are
separate gates; see the [migration design](superpowers/specs/2026-09-23-app-sdk-package-naming-migration-design.md).
Do not use these checks as evidence that any renamed package is already public.

## Existing Release Line

Published synchronized beta `1.1.0` includes the Apple `BotaAppleSDK` Swift
package for iOS 15+ and macOS 13+, the Android Maven package, and the React
Native package. `1.2.0-beta.0` is occupied by an immutable annotated tag for
non-Flutter source; it must not be reused for the prepared Flutter facade. The
unpublished `v1.2.0-beta.1` and `v1.2.0-beta.2` tags are also immutable and
must not be moved after their release workflows failed. Beta.2 stopped at the
candidate-inventory projection before signing or publishing any artifact;
its package bytes matched the main-CI inventory. `1.2.0-beta.12` is the selected
replacement candidate. Its Web foreground implementation and automated Chromium/package
gates are complete; supervised Web physical-device acceptance remains open.
The beta.3 Central deployment reached `PUBLISHED`, but the tagged release
workflow stopped before npm and Apple publication because Central did not serve
the HTML version-directory index within its ten-minute verification window.
All 30 expected public Maven files were independently verified against the
signed inventory. A same-tag retry after the index appeared failed closed
because PGP signing produced different bytes from the archived Central bundle.
The beta.3 tag remains immutable. Beta.4 uses the corrected file-based verifier
and restores preserved signed inputs before signing on a same-tag retry.
The immutable beta.4 tag passed main CI, but its tagged Android packaging job
failed twice in a START-reply test fixture before any registry write. Its
protected publish job was skipped. Beta.5 synchronizes the corrected test
fixture; do not move or reuse beta.4.
Beta.5 also passed main CI, but the tagged Android unit-test step stalled and
the run was cancelled before publication. Beta.6 uses a per-subscription test
barrier and bounded cleanup. The tagged Android packaging step also has a
15-minute timeout to fail before publication on any future stall. Do not move
or reuse beta.5.
Beta.6 passed main CI but failed a tagged START-dependent Android unit test
before publication. The test class mixed virtual `runTest` time with real IO;
beta.7 uses `runBlocking` for that integration fixture. Do not move or reuse
beta.6.
Beta.7 published Apple SwiftPM, Android Maven, React Native npm, and Web npm,
but CocoaPods Trunk rejected the first `BotaAppleSDK` pod after local iOS/macOS
validation. The tagged podspec used `prepare_command`, which Trunk does not
allow for a new pod. Flutter and synchronized completion were held. Do not move
or reuse beta.7. Beta.8 distributed a checksummed CocoaPods archive containing
the same Swift facade sources and XCFramework without install-time scripting.
Apple SwiftPM, CocoaPods, Android Maven, React Native npm, and Web npm are
public at beta.8, but its pod workflow failed after Trunk registered the pod:
the CDN-backed `pod spec cat` lookup missed the new registration and a retry
attempted a duplicate push. Flutter was held. Do not move or reuse beta.8.
Beta.9 checks the authoritative Trunk API before pushing and after any uncertain
push result, so a delayed CDN index cannot cause a duplicate submission.
Beta.9 published Apple SwiftPM, CocoaPods, Android Maven, React Native npm, and
Web npm, and all public consumers passed. Flutter was nevertheless skipped:
GitHub propagated the deliberately skipped Central recovery job through the
release dependency graph. Do not move or reuse beta.9. Beta.10 corrected the
Flutter-side job conditions and published the native and npm artifacts, but the
Flutter candidate job failed because its consumer gate could not locate the
installed CocoaPods 1.16.2 executable. Do not move or reuse beta.10. Beta.11
passes the installed executable explicitly to that gate and checks its exact
version before building consumers.
Beta.11 still failed there: the runner's default Ruby found a different pod
version after the gem install. The next candidate installs CocoaPods into an
isolated gem directory with a dedicated executable path. Main CI first uses
that same installer to compile a public beta.11 CocoaPods consumer on macOS;
the tagged Flutter job then uses it for its matching public version.
The installer selects the available RubyGems executable on the runner; it does
not assume a Homebrew Ruby path exists on GitHub's macOS image.
The public consumer invokes the pinned gem with RubyGems' `_1.16.2_` version
selector, because the runner can have a newer CocoaPods gem installed globally.
The macOS public-pod consumer uses portable `grep` for its lockfile checks;
GitHub's runner image does not include ripgrep.
Apple consumers add
`https://github.com/bota-dev/app-sdk.git` in Xcode. The root `Package.swift`
compiles the Swift facade source and downloads a checksummed
`BotaDeviceSDKCore.xcframework.zip` from the matching GitHub Release.

The nested `platforms/apple/Package.swift` remains the local-development
package. It points at the generated XCFramework on disk so facade tests do not
depend on a published release.

The Flutter `bota_flutter_sdk` facade is implemented and locally gated for iOS
15+ and Android API 26+, but it was not published with synchronized version
`1.1.0` or the occupied `1.2.0-beta.0` identity. Do not advertise or attempt to
recover either nonexistent Flutter artifact.

The Android package uses Maven coordinate `dev.bota:bota-android-sdk`. The
synchronized `1.1.0` beta release publishes it through the protected Central
Portal workflow after deterministic packaging and native acceptance gates pass.

All artifacts use the exact version in `sdk-version.toml`. Release tags use
`vVERSION`; the tag, package metadata, public Swift version, compatibility
matrix, release example, GitHub Release URL, and XCFramework checksum must
agree. The Apple workflow does not publish the Rust core or FFI crates to
crates.io.

The synchronized line is beta. New versions must match `1.x.y-beta.n`, npm
publication must use dist-tag `beta`, and GitHub Releases remain prereleases.
SwiftPM and Maven Central consumers pin the exact synchronized beta version.
Historical immutable `1.1.0` is the one recovery exception; do not rename,
unpublish, or recreate it. The next synchronized release is selected as
`1.2.0-beta.12`; do not move, delete, recreate, or reuse `v1.2.0-beta.0`
through `v1.2.0-beta.11`.
Before that first Web publication, configure the npm trusted publisher for
`@bota.dev/web-sdk` against the protected `release` environment and this
repository's release workflow. The workflow intentionally has no token-based
fallback.

## Repository Setup

Configure two GitHub environments for `bota-dev/app-sdk`:

1. `release-approval`: require the release owner's review, allow release tags
   (`v*.*.*`) and `main` for manual recovery, and store no secrets.
2. `release`: retain the same tag/main restrictions and registry OIDC identity,
   with no required reviewers or wait timer. Store only
   `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`,
   `SIGNING_IN_MEMORY_KEY`, `SIGNING_IN_MEMORY_KEY_PASSWORD`, and
   `COCOAPODS_TRUNK_TOKEN` as environment secrets. Do not add a crates.io or
   pub.dev token; Flutter's later automated publications use OIDC.

### Single-approval migration

The release owner requested one approval for the entire synchronized release
on 2026-09-28. `approve-release` waits for verified promotion of all five CI payloads, then pauses
at `release-approval`. Publication, CocoaPods, native public consumers and the
Flutter candidate retain their existing ordering. Future tags use one workflow
dependency graph for Flutter publication; historical tags retain their separate
publisher and matching-run approval check. Read-only candidate/public archive
verification does not access an environment. Manual Central recovery uses a
separate `approve-recovery` job, so a recovery dispatch still needs one review.

Activate in this order:

1. Create `release-approval` with the existing release reviewer and the same
   `main` branch / `v*.*.*` tag restrictions; keep it secret-free.
2. Pass exact-revision CI and License Gate, then merge the workflow change.
3. Stop starting legacy publication/recovery runs. Finish or cancel every
   active legacy `release.yml` and `publish-flutter.yml` run, including old
   waiting jobs, before removing required reviewers from `release`; otherwise
   the settings change could unblock an old run without its first approval.
   Retain all five secrets, branch/tag restrictions and OIDC registration.
   Do not push another release tag during this cutover.
4. Verify both environment configurations. The next legitimate release must
   pause once at `Approve SDK release` and continue downstream without reviews.

Tagged workflow source is immutable. Old tags do not contain the new approval
job: do not rerun their publishing jobs after the settings cutover. Use current
`main`'s gated recovery for supported recovery operations; any other historical
publication requires an explicit reviewed recovery path. Restoring reviewers
on `release` is the rollback if the replacement approval gate is unavailable.

### Immutable beta.4 recovery after the approval cutover

`recover-beta4.yml` is a finite exception for the stranded `v2.0.0-beta.4`
release, not a general historical-run selector. Dispatch it from current
`main` only after that exact revision's CI and License Gate pass. Its read-only
preflight precedes one `release-approval` review. The controller receives only
`actions: write` and `contents: read`; it receives no registry credentials and
does not publish packages itself. Do not rerun the historical publishers directly.

The reviewed identities are fixed in `tools/release/recover-beta4.mjs`:

- Annotated tag object: `db26c88d45582238d94e66e64365bbd04a518b7b`.
- Source revision: `4b972255d2d9d3005278799451741e025afed168`.
- Candidate inventory SHA-256: `87f00905121df029cdbc534e33e2701c0755e0a19873d09f05e48d9146416540`.
- Original release: [36343414157](https://github.com/bota-dev/app-sdk/actions/runs/36343414157).
- Original Flutter OIDC publisher: [36343414333](https://github.com/bota-dev/app-sdk/actions/runs/36343414333).

Recovery verifies the tag/annotation, inventory bytes, the four preserved native
and npm artifact IDs/digests/source/expiration, original tag-push run identities,
and all successful package/public-native-consumer prerequisites. It refuses an
already active historical run. After approval it repeats preflight, verifies
the approval in this exact controller run/revision, and resumes only a failed
CocoaPods or Flutter stage and its dependents. Successful native/npm publication
jobs are never selected. The original tagged checks, secrets environment and
pub.dev tag-push OIDC identity remain in force.

The controller waits for the original CocoaPods/public-native checks and Flutter
candidate build to succeed. It independently checks every Flutter ZIP file
against the annotation-bound candidate inventory before resuming the separate
OIDC workflow. Both original workflows must finish successfully, including
public archive verification and final evidence attachment. A failed final
verification/attachment stage from an earlier attempt can be resumed with a new
approved dispatch; a new failure during recovery stops without automatic retries.

GitHub repopulates carried prerequisite jobs asynchronously after accepting a
rerun. Polling reads jobs from the exact attempt returned by run metadata and
waits when an active attempt temporarily omits a prerequisite or has no result
for it yet. This pending state never authorizes Flutter artifact consumption or
another publisher. Completed attempts still require the complete job set;
actual failed/cancelled/skipped prerequisites and unknown/duplicate jobs fail
immediately. Preflight, artifact consumption and rerun selection remain strict.

Each polling phase is bounded to 120 minutes; the controller job has a 240-minute
limit. Its concurrency group differs from the original release group so it does
not prevent the jobs it awaits from starting. Cancelling or timing out the
controller does **not** cancel already resumed original jobs: inspect both run
links and let them finish or explicitly cancel them before another dispatch.
Never move the tag, rebuild native inputs, change environment rules, or upload
an alternative package to work around a failed check.

Post-implementation review against the single-approval policy and synchronized
release acceptance criteria:

| Requirement | Evidence | Conformance / remaining verification |
| --- | --- | --- |
| Current protected approval before historical publication | Main-only dispatch; one secret-free `release-approval` job; controller rechecks exact run/revision approval | Hosted preflight and owner approval passed in run `36473229435`; approved CocoaPods attempt started; synchronized completion pending |
| Immutable source and approved bytes | Pinned tag object/source/inventory; preserved artifact IDs/digests; exact Flutter file comparison | Negative tests and live read-only preflight pass; future Flutter artifact verification pending |
| Retain all native/public-consumer and publication gates | Required successful original jobs; original tagged downstream jobs and OIDC workflow; both final conclusions required | Ordering tests pass; CocoaPods service recovery and public Flutter verification pending |
| Fail closed without repeat publication | No arbitrary run inputs; failed-job-only API; no native/npm reruns; bounded polling; new failure stops | Failure, timeout, identity, approval, artifact and partial-attempt regression tests pass; corrected hosted polling remains unverified |
| Hardware/app rollout remains separate | No device operation, version/tag rewrite, Portal deployment or acceptance assertion | Matched; physical/browser acceptance remains unverified |

Local verification: 19 recovery tests and six existing approval/completion tests
pass; actionlint 1.7.12 passes. A read-only preflight against the live historical
runs, artifacts and then-current main quality gates passed on 2026-09-28. This
does not authorize publication from the local shell or prove hosted recovery.
Exact pushed-revision CI and License Gate remain mandatory before main activation.

Runtime follow-up (2026-09-28): controller job `109103185437` correctly resumed
CocoaPods, then failed one second later with `native/public prerequisite failed`
while GitHub populated attempt 6. The original CocoaPods job continued; the
controller failure did not establish a native gate failure. Four regression
tests reproduced the polling/read issues before the correction; all 25 focused
tests now pass. The fix pins attempt reads and treats incomplete active
prerequisites as pending within the existing bound, without weakening completed
gates or adding a publishing retry. Exact-revision CI and hosted recovery are
still required for this correction.

### Single-approval implementation review

Design review for the original single-approval change:

| Requirement | Evidence | Status |
| --- | --- | --- |
| One human decision before external publication | Approval-only job after package gates; publish depends on approval; recovery has its own gate | Matched in source and workflow regression tests; live activation/next release unverified |
| Preserve secrets and trusted publisher identity | Native/npm, CocoaPods and Dart upload retain `release`; no secret copied or output | Matched in source; next publication unverified |
| Preserve ordered exact artifacts and public consumers | Existing dependencies and inventory/hash checks retained; Flutter additionally checks matching run approval | Matched in source; hosted CI required |
| Preserve external hardware acceptance boundary | Release owner reviews the complete release once; no hardware status changed | Matched; no physical acceptance claimed |

Local Windows verification: six release-completion/approval tests and actionlint
1.7.12 on all four changed workflows pass. CI's tooling job now runs
`npm run test:release`, including the approval regressions. The
broader release suite reports 85 passed / 21 failed with Windows path, CRLF
and shell-execution failures; Linux/macOS CI remains required before merge.
`release-approval` was created with the existing reviewer and matching ref
restrictions. The old `release` reviewer remains until the ordered cutover.

The `release-approval` approval is the human boundary for release authorization and
external hardware acceptance. Automated tests never claim a physical-device
result. Keep supervised device evidence separate and follow
[`docs/testing/apple-physical-device.md`](testing/apple-physical-device.md) when
new hardware or firmware requires another lab run.

For the Web facade, follow
[`docs/testing/web-physical-device.md`](testing/web-physical-device.md) in a
supported desktop Chromium browser. The reviewer must confirm every required
row against one exact Bota device and the exact candidate source revision.
`npm run web:verify` uses deterministic fake Bluetooth and is not a substitute.
Ordinarily, do not approve `release-approval` while a required
Web row is `NOT RUN` or failed. For `1.2.0-beta.7` and its CocoaPods repairs
`1.2.0-beta.8`, `1.2.0-beta.9`, `1.2.0-beta.10`, `1.2.0-beta.11`, and `1.2.0-beta.12`, the release owner explicitly requested a public beta rollout
before supervised production-device testing. This authorizes publication for
that post-release test, not a claim
of Web hardware acceptance or general availability. A failed automated gate
still blocks publication, and any failed supervised row must be triaged before
another version is released. The open hardware status is recorded in
[`release/evidence/1.2.0-beta.12-web-foreground.md`](../release/evidence/1.2.0-beta.12-web-foreground.md).

## Prepare A Version

Start from a clean `main` branch. Update every synchronized version authority
and commit that version bump before calculating the Apple checksum.

While the beta policy is active, select a new `1.x.y-beta.n` version that is not
already occupied. Update every version authority and the matching
`release/examples/VERSION.json` together. The release-channel resolver rejects
a new stable tag before any publication work starts.

The React Native Codegen contract includes the package version in its digest.
After a version bump, regenerate and review it before committing:

```bash
npm run codegen --prefix frameworks/react-native
npm run codegen:check --prefix frameworks/react-native
```

Generate deterministic SwiftPM and CocoaPods archives and write their matching
root manifests:

```bash
tools/apple/package-release.sh --write-package-manifest
swift package dump-package
git diff -- Package.swift platforms/apple/BotaAppSDK.podspec
```

The explicit preparation mode builds from the current working snapshot,
computes its SwiftPM and CocoaPods checksums, and changes only the two public
package manifests; this permits a
synchronized version change and its generated checksums to land in one commit.
Review and commit both manifests. The CocoaPods source is a checksummed
`BotaAppSDK.cocoapods.zip` containing Swift sources and the generated
XCFramework; it must not use `prepare_command`, which Trunk rejects for new
pods. Then rerun the normal check-only mode from the
new clean commit:

```bash
tools/apple/package-release.sh
```

Normal mode fails if rebuilding the XCFramework produces a checksum different
from the committed root package. Never hand-edit the release URL or checksum.

PR and main CI use `tools/apple/package-release.sh --evidence-only` to generate
and validate unpublished evidence for the current commit without comparing it
to the immutable package from the previous release. The protected release
workflow promotes that preserved candidate and verifies
its checksums against the committed root manifests; it does not rebuild it.

The matching `tools/apple/test-pod-archive.sh --evidence-only` lints a temporary
podspec generated from that candidate archive's verified checksum. It never
changes the committed podspec. Normal mode, including every tagged release,
still rejects an archive that differs from the committed checksum. Regression
tests cover stale release checksums, isolated candidate specs, and corrupt
archives; CI must not compare new source against the preceding release archive.

## Local Release Gate

Use Node.js 22 or newer and the Rust toolchain pinned by the repository:

CI checks out the pinned maintenance React Native workflow baseline below
`.ci/`. Do not move that checkout below Cargo's `target/`; the Rust cache action
may recursively clean that directory before the baseline dependency install.

Before the local Web gate, install only the Playwright 1.63.0 Chromium build
into the repository target directory. `web:verify` then creates one
`target/web-release` tarball and inventory, installs only that tarball into the
Vite consumer, and runs its production build and browser cases. The release
workflow publishes this verified payload unchanged.

```bash
npm ci
npx --yes npm@12.0.2 ci --prefix tests/consumers/web-vite
PLAYWRIGHT_BROWSERS_PATH="$PWD/target/playwright-browsers" \
  tests/consumers/web-vite/node_modules/.bin/playwright install chromium
npm run check
npm run test:tooling
npm run test:release
npm run web:verify
npm run sync:apple-fixtures
npm run test:workflows -- --sdk-path ../react-native-sdk
cargo xtask release verify-tag "v$(sed -n 's/^version = "\([^"]*\)"$/\1/p' sdk-version.toml)"
cargo xtask protocol generate --check
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
tools/ffi-smoke/run-native-c-smoke.sh
tools/ffi-smoke/run-native-swift-smoke.sh
tools/apple/test-package.sh
tools/apple/test-consumer.sh
tools/apple/package-release.sh
tools/apple/test-pod-archive.sh
tools/flutter/run-flutter.sh test frameworks/flutter/bota_app_sdk/test
tools/flutter/test-android-adapter.sh
tools/flutter/test-consumers.sh
npm run flutter:verify
# Automatic CI-equivalent verification; beta.1 preserves a release candidate.
tools/flutter/package-release.sh --ci
# Strict local release gate for selected beta.1; occupied beta.0 still refuses.
tools/flutter/package-release.sh --check
node --test tools/flutter/verify-publication.test.mjs tools/release/*.test.mjs
cargo deny check
```

## Android Package Gate

Android release checks require JDK 17, Android SDK 36, NDK 28.2.13676358,
Node.js 22+, OpenSSL, and GnuPG. The check-only package command requires a clean
HEAD and writes only below `target/`:

```bash
tools/android/test-publication-graphs.sh
tools/android/package-release.sh --check
tools/android/verify-publication.sh target/android-release
cargo xtask release validate target/android-release/release-manifest.json
tools/android/install-release-repository.sh target/android-release target/android-m2
tools/android/test-legacy-consumer.sh --mode source --compile-only --repository target/android-m2
tools/android/test-legacy-consumer.sh --mode binary --compile-only --repository target/android-m2
tools/android/test-consumer.sh --compile-only --repository target/android-m2
```

`package-release.sh --check` performs two clean builds and rejects any AAR or
per-ABI native-library digest drift. It invokes only the unsigned local Maven
publication, proves that no signing task or `.asc` file is present, and emits
the AAR, POM, Gradle module metadata, sources, Dokka Javadoc, four checksum
formats for every Maven primary, copied MIT license, SPDX 2.3 SBOM, and native
manifest version 2. The host-side consumer compile commands catch source and
binary fixture drift before either emulator lane starts.

The published runtime dependency set is reviewed in
`protocol/baseline/android-maven-license-policy.json`. The package command and
license workflow require every Gradle module dependency to have an exact
coordinate, version, approved license, and reviewer in that policy, and require
the SPDX declaration to match. Unreviewed Maven dependencies fail closed.

The API compatibility lanes consume the reconstructed repository rather than
republishing from source:

```bash
tools/android/test-emulator-lane.sh --api 26
tools/android/test-emulator-lane.sh --api 35
```

The exact x86/x86_64 images run on Ubuntu release CI. Apple Silicon cannot run
the required API 26 x86 image, so a local arm64 emulator is not equivalent
release evidence. Each lane exports a fresh, lane-local `ANDROID_AVD_HOME` so
`avdmanager` and the emulator resolve the same AVD. ADB attachment is bounded;
an emulator that exits or never registers fails with the ADB device list and
captured emulator output instead of leaving the release job blocked.

The separate publication-graph test creates a password-protected ephemeral PGP
key in a mode-0700 temporary keyring. It proves that protected staging cannot
start without both in-memory key properties, then verifies all five detached
signatures. Gradle's exact 55-file raw repository is normalized to the 30-file
Central Portal tree. The generated ZIP contains only the path-sorted Portal
inventory, with mode 0644 and the fixed 1980 DOS timestamp; the inventory stays
beside the ZIP rather than inside it.

Protected automation sets only these environment-backed Gradle properties:

```text
ORG_GRADLE_PROJECT_signingInMemoryKey
ORG_GRADLE_PROJECT_signingInMemoryKeyPassword
ORG_GRADLE_PROJECT_signingInMemoryKeyId  # optional
```

The protected command must include the exact opt-in
`-PbotaProtectedSigning=true`. Any other value fails configuration. Never put
the key, password, or key ID in command arguments, tracked files, build scans,
logs, or uploaded artifacts.

`tools/apple/package-release.sh` writes the release payload to
`target/apple-release/`:

- `BotaDeviceSDKCore.xcframework.zip`
- `BotaDeviceSDKCore.xcframework.zip.sha256`
- `BotaDeviceSDKCore.xcframework.swiftpm-checksum`
- `BotaAppSDK.spdx.json`
- `LICENSE`
- `release-manifest.json`

Future Apple packaging emits release manifest version 2 with
`sdkFamily: "bota-app-sdk"` and artifact fields `platform: "apple"` and
`packageIdentifier: "BotaAppSDK"`. The public JSON Schema and Rust validator
require every version 2 platform/package identifier to be one exact pair from
the public package matrix; independently valid platform and package values
cannot be mixed.

The public `v1.0.0` manifest is an immutable version 1 document. Historical
evidence uses `validate_manifest_format_and_semantics`, which validates its own
SDK/artifact version consistency, checksums, firmware range, capabilities, and
v1/v2 rules without consulting the current checkout version. Normal
`validate_manifest` calls and `cargo xtask release validate` additionally
require `sdkVersion` to equal the current `sdk-version.toml`; release candidate
validation must always use that strict path.

The packaging log includes SHA-256 digests for every normalized XCFramework
input and for the final archive. Use those values to identify toolchain-specific
output before changing the checksum pinned in `Package.swift`.
Rust compilation remaps the checkout and Cargo registry paths, and packaging
fails if either original machine-specific prefix remains in a static library.

The XCFramework contains arm64 iOS, arm64/x86_64 iOS Simulator, and
arm64/x86_64 macOS slices.

## Flutter Package Gate

Flutter verification must use the repository wrapper, which pins Flutter
3.47.2 and Dart 3.13.2. The package version and its packaged Android
`sdk-version.toml` must equal the root version, generated Pigeon Dart, Swift,
and Kotlin outputs must be byte-identical, and analysis plus all Dart tests must
pass.

`tools/flutter/test-consumers.sh` is the pre-publication mobile build gate. It
must:

1. Reject missing or empty iOS Bluetooth usage descriptions and incomplete
   Android API 26-35 Bluetooth permissions.
2. Rebuild the local Apple XCFramework and Android Maven candidate after
   removing the prior exact-version Android directory.
3. Generate a complete disposable Flutter iOS/Android application and use an
   isolated Gradle home.
4. Resolve `BotaAppSDK` from the exact local package and reserve the
   `dev.bota` group for the exact local Android repository.
5. Produce a new Android release APK and unsigned iOS release application.

The maintained `example/` directory intentionally contains only application
source, package metadata, and permission manifests. Generated runner files are
never release evidence by themselves. A consumer failure must not fall back to
an earlier application build, cached native candidate, remote Maven artifact,
or remote Apple package.

The first Flutter beta may be published only after every `2.0.0-beta.0` version
authority changes together and the Apple
and Android artifacts at that exact version are public with passing no-override
consumers. The initial pub.dev publication mechanism must be deliberately
authorized for that selected version; the workflow no longer prints a beta.0
publish command. Later prereleases use pub.dev's GitHub OIDC workflow. Every
publication is downloaded and compared with the candidate's exact file hashes
and normalized archive SHA-256 before release completion.

`tools/flutter/package-release.sh --check` refuses occupied
`1.2.0-beta.0`. For selected `2.0.0-beta.0`, it writes
only deterministic evidence to `target/flutter-release/`: the candidate
archive, exact package inventory, v2 release manifest, dependency lock and
graph, hosted-package license hashes, normalized dry-run output, and fixed
verification record. It rejects unsafe or hidden paths, links, credentials,
generated/build outputs, local Apple overrides, unreviewed extras, and raw,
normalized, or per-file checksum drift.
The checked release example freezes the tooling-generated preparation
revision; check mode permits only that revision field to differ from a runtime
candidate, which always records the current Git revision. Do not hand-edit a
source revision, archive checksum, file inventory, or root Swift checksum.

Automatic PR/main CI uses `tools/flutter/package-release.sh --ci`. That mode
runs the same analysis, tests, license audit, publication dry run, and fresh
Android/iOS consumer builds. For occupied beta.0 it reports
`candidate-ready=false`, removes any stale Flutter candidate directory, and
succeeds without creating release bytes. For beta.1 and later synchronized
versions it reports `candidate-ready=true` and creates the same deterministic
candidate as check mode.

## Publish

Configure npm trusted publishers for `@bota.dev/react-native-app-sdk` and
`@bota.dev/web-app-sdk` with organization `bota-dev`, repository `app-sdk`,
workflow `release.yml`, environment `release`, and allowed action `npm publish`.
Each package has one trusted publisher. Preserve old-package publishers for
maintenance and historical recovery. npm requires a package to exist before
this grant can be configured; staged publication cannot create a new package.
See [npm trust](https://docs.npmjs.com/cli/v12/commands/npm-trust/).

Both npm grants are saved and verified as of 2026-09-24. Web setup completed
through an interactive npm 12.0.2 `trust github` command after the website
repeatedly returned to authentication without saving. Its successful command
result and fresh package-settings readback matched the exact grant above, with
`publish` and npm's baseline `stage publish` permissions. Package access and
maintainers were unchanged. If the UI loses a pending save, use the supported
CLI and keep its single authentication request alive until it completes:

```bash
npx --yes npm@12.0.2 trust github @bota.dev/web-app-sdk \
  --repo bota-dev/app-sdk --file release.yml --env release \
  --allow-publish --allow-stage-publish --yes --browser=false
```

This is the completed setup command, not a routine release step. Do not rerun
it or replace an existing grant without checking the saved configuration.
Keep security-key approval interactive; do not copy its temporary credentials
into repository files or CI secrets.

On 2026-09-24, the release owner approved this one-time bootstrap for
`2.0.0-beta.0`, replacing the impossible pre-tag publisher prerequisite:

1. Tag only the verified main-CI five-platform candidate and approve the
   protected native publication after all automated gates pass.
2. Wait for exact Maven publication and public Apple binary verification, then
   publish the exact CI npm archives using the owner's interactive login and
   `tools/release/publish-npm.mjs`. Preserve the explicit `beta` tag and all
   historical tags; never create a dummy version or store an automation token.
3. Configure only the repository/workflow/environment/action grant above and
   read it back. Resume the same tagged workflow, which verifies occupied npm
   versions rather than replacing them. Preserve Central's signed inputs.
4. After public native consumers pass, publish Flutter from the exact ordered
   release candidate using the owner's pub.dev login. The automatic workflow
   verifies the occupied version and skips a second upload. This historical
   bootstrap procedure does not add a second approval to the current flow.
   Future pub.dev automation uses the configured GitHub publisher below.

Flutter automated publishing was saved and read back on 2026-09-24 for
`bota_app_sdk`: repository `bota-dev/app-sdk`, tag pattern `v{{version}}`,
push events only, and required environment `release`. Manual publishing remains
enabled; workflow-dispatch and GCP publishing remain disabled. Package ownership
is unchanged. The `publish-flutter` job in `release.yml` uses `environment: release`
and the official Dart setup action so the actual OIDC upload carries that
environment identity. Historical tags use the separate reusable publisher. The single-approval
migration above moves human review to `release-approval` while preserving this
OIDC identity and the branch/tag restrictions. Do not publish
a dummy version or replay the immutable bootstrap tag to test this configuration.

For a manual Flutter bootstrap, extract the verified ordered archive outside
any Git checkout. An ignored `target/` directory inside the repository causes
pub to exclude the entire package. Run the pinned publication dry run with
zero warnings, verify every file against the candidate inventory, then publish
without modifying package files. Pub may change tar metadata/compression;
public acceptance compares the normalized digest and every file checksum.

This approval authorizes a beta rollout, not hardware acceptance. Physical
device testing remains NOT RUN. Do not weaken an automated gate or change the
immutable tag to recover publication.

This workflow owns npm `beta`; the legacy React Native repository owns that
historical package's `latest`. Every npm publication command includes
`--tag beta`, verifies the candidate `dist.shasum`, and proves that existing
`latest` tags are unchanged.

The registry assigned both `beta` and `latest` to the first renamed RN upload
despite the explicit `--tag beta`; its authenticated `latest` removal returned
HTTP 400. On 2026-09-24 the release owner approved retaining
`latest -> 2.0.0-beta.0` on the two new npm identities only. The Web bootstrap
received the same tags. Keep these first-version `latest` tags pinned until a
separately approved stable-channel change; subsequent beta releases update
only `beta`. Never remove, move, or recreate a historical package tag as part
of this exception. The packages and GitHub release remain prereleases.

First-package version endpoints can become visible before the package-level
metadata. If upload succeeds but immediate tag verification fails, query the
occupied version and compare its exact archive before retrying verification;
never attempt to upload that version again. Record both the registry-created
tags and their explicit owner approval instead of treating the failed initial
check as synchronized release success.

After the release commit is on `main`, require successful `CI` and `License
Gate` push runs for that exact revision. CI builds and tests all five payloads,
including the fresh Flutter Android/iOS applications and ephemeral-key Android
publication graph. The `Release candidate inventory` job preserves the complete
file inventory and reports its run ID. An inventory without Flutter is not a
synchronized release candidate.

Future tags containing the promotion workflow bind both the original successful
main CI run and its inventory digest. Do not select a newer run during a retry:
even a green run for a different source revision is not interchangeable.

```bash
VERSION=$(sed -n 's/^version = "\([^"]*\)"$/\1/p' sdk-version.toml)
SOURCE_REVISION=$(git rev-parse HEAD)
CI_RUN_ID=123456789 # Replace with the successful main CI run for SOURCE_REVISION.
CANDIDATE_INVENTORY_SHA256=$(awk '{print $1}' \
  /path/to/release-candidate-files.json.sha256)
git tag -a "v$VERSION" \
  -m "Bota App SDK $VERSION" \
  -m "Source-Revision: $SOURCE_REVISION" \
  -m "Candidate-Run-ID: $CI_RUN_ID" \
  -m "Candidate-Inventory-SHA256: $CANDIDATE_INVENTORY_SHA256"
cargo xtask release verify-tag "v$VERSION"
git push origin "v$VERSION"
```

`tools/release/promote-ci.mjs` validates the annotated tag, original CI run's
repository/workflow/main-push identity and successful conclusion, and successful
exact-main License Gate. It downloads each artifact by ID, rejects expired or
ambiguous artifacts, verifies the transport SHA-256 itself, and checks every
file against the tag-bound inventory before writing any payload. Missing,
extra, unsafe, or changed files fail closed. `ci-promotion.json` records the
source, tag object, original run, artifact IDs and digests and is preserved on
the GitHub release. Promotion rechecks the tag after downloading. There is no rebuild
or latest-run fallback. Preserve the CI artifacts until release completion;
if they expire, restore separately verified archived evidence through an
explicit recovery procedure or prepare a new version, never move the tag.

The single tag-triggered release workflow then:

1. Verifies synchronized metadata, main ancestry and the promoted payloads.
   It rechecks the root SwiftPM and CocoaPods checksums against the preserved
   Apple archives because normal CI's evidence mode does not check those roots.
2. Requires one `release-approval` decision. Downstream `release` environments
   retain secrets and registry OIDC identity without another reviewer gate.
3. Uses `tools/android/sign-preserved.mjs` to sign the five verified Maven
   inputs with the existing protected key. It verifies the signatures, retains
   the 30-file Central normalization/public checks, and archives the signed
   bundle before publication. Retries restore that exact signed bundle.
4. Publishes or verifies the preserved native and npm artifacts. npm advances
   only `beta`, checks exact occupied bytes, and preserves `latest`.
5. Publishes or verifies CocoaPods, waits for CDN readiness, and runs the public
   SwiftPM, CocoaPods and API 26/35 Maven consumer gates. Registry acceptance
   alone does not establish customer install readiness.
6. Verifies the already preserved Flutter payload against the tag inventory;
   it does not rebuild the package, native libraries or local Flutter examples.
7. Publishes Flutter in the same dependency graph, respecting workflow
   cancellation through `!cancelled()`. On every attempt,
   `tools/flutter/prepare-publication.mjs` first verifies the candidate and any
   occupied pub.dev archive. Only HTTP 404 authorizes upload; authentication,
   transport and checksum failures stop. An identical occupied version skips
   upload. The official pinned `dart-lang/setup-dart` action supplies OIDC in
   the tag-push `release` environment. The verified archive is extracted outside
   the checkout, uses the preserved lock with `--enforce-lockfile`, and is
   published with the repository's checksum-pinned Flutter SDK. No long-lived
   token or separate polling workflow is used.
8. Downloads the public Flutter archive and checks every normalized file hash
   before attaching evidence and completing the synchronized prerelease. The
   final progress summary distinguishes candidate integrity, publication,
   public consumers and completion. CI does not claim hardware acceptance.

Use GitHub's failed-job retry for a transient failure in this new graph. It
retains successful upstream checks and the original tag source. A failed
publication job may have already written to a registry: its occupied-version
checks and preserved Central bundle determine what remains. Re-running candidate
promotion may replace this run's transport artifacts only after validating the
same original CI bytes; it cannot replace published package bytes. Historical
tags, including beta.4's separate publisher, retain their original workflow
and require their documented recovery path.

Design review of the promotion change (future releases only):

Local verification: 88 focused promotion, signing, Flutter, recovery, npm and
workflow tests pass, as do actionlint and shell syntax checks. A read-only replay
against CI run `36477004338`, using synthetic tag metadata without creating a
tag, verified all 49 preserved payload files. Six unchanged broader Maven tests
hit Windows path-separator assumptions; Linux hosted checks remain required.
The maintenance-baseline checkout assertion applies to CI, where the selected
reference tests execute; release promotion requires that exact CI conclusion.
Hosted Linux tooling, release-helper tests and ephemeral-key signing passed on
the feature revisions. The final exact-revision CI and License Gate remain
required before merging. The license assertion verifies the existing pinned
cargo-deny action with `check licenses`.

| Requirement | Evidence | Status / remaining verification |
|---|---|---|
| Exact green main source and immutable candidate | Pinned run annotation, CI/License identity checks, ZIP digests, full five-platform file comparison | Matched in local tests and full main CI `36488752213` at `875a4cd` |
| No duplicate package/native build during publication | Promoted archives; preserved-input Maven signer; Flutter extraction | Matched in source and signer tests; ephemeral-key hosted signing/normalization passed |
| One approval, original tag OIDC and public consumer gates | Explicit release dependencies, protected environments, public native/archive checks | Matched in workflow checks/actionlint; next legitimate tagged publication unverified |
| Retry without replacing accepted versions | Existing Central/npm/CocoaPods checks plus Flutter occupied-file verification | Local retry/corruption tests pass; next tagged end-to-end retry unverified |
| Hardware/app acceptance remains separate | Existing physical matrix and rollout gates retained | Unverified; this change supplies no device evidence |

Main CI uses local native dependencies because the new version's public URLs
do not exist until publication. Public install checks remain after native
publication. The old separate `publish-flutter.yml` is removed from current
source; immutable tags still contain their historical version.

The protected workflow stages the signed raw Maven repository with in-memory
PGP material, normalizes it to the exact 30-file Portal tree, and persists the
bundle, inventory, and `central-portal-state.json` on a draft GitHub Release
before upload. The initial HTTP 201 deployment UUID is fsynced before polling.
An uncertain upload outcome stops automatic retries; use the protected
`workflow_dispatch` recovery with the exact `refs/tags/v<version>`, the Portal
UUID, the original tag workflow `releaseRunId`, and
`centralRecoveryMode=resume-uncertain`. That mode downloads the preserved bytes
and never rebuilds, re-signs, or re-uploads them.

Detached PGP signatures include their creation time, so rerunning the tag job
first checks the draft release. If all four preserved inputs exist, it verifies
the archived candidate, signed ZIP, state hashes, coordinate, source revision,
and tagged AAR, then skips signing and resumes from those exact bytes. An
incomplete archive fails closed. It must not replace the preserved Central ZIP
with newly signed bytes. If Central
returns a confirmed `FAILED` deployment, first fix the reported external
validation cause, then dispatch `centralRecoveryMode=retry-failed` with that
failed UUID. The protected job verifies the old deployment is `FAILED` and has
the preserved deployment name, recreates `READY` state from the archived ZIP
and inventory, and uploads those exact bytes as a fresh deployment. The new
state records `retryOfDeploymentId` for auditability.

Both recovery modes download the original run's Apple, Android, React Native,
and Web artifacts and compare their non-Flutter subset with the five-platform
candidate inventory preserved on the draft release. They never rebuild or
publish Flutter. After Central and its public inventory pass, the recovery job
publishes or verifies both exact npm tarballs under
`beta`, leaves `latest` unchanged, publishes the existing GitHub prerelease
assets, and enables the same public SwiftPM plus API 26/API 35 Maven consumer
jobs as the tag workflow. Recovery resolves metadata from the requested tag;
new release mode rejects stable tags while historical `v1.1.0` recovery remains
available.

Rerunning an occupied Flutter version does not invoke an interactive or OIDC
publish command. It downloads the preserved candidate and the existing public
archive, verifies them, and resumes release completion only when every byte-level
inventory contract passes.

Central states resume as follows: `PENDING` and `VALIDATING` poll,
`VALIDATED` publishes once, `PUBLISHING` polls, `PUBLISHED` verifies the public
repository, and `FAILED` stops with sanitized errors. A missing public POM is
not evidence that another upload is safe; only the explicit failed-deployment
path may create a replacement upload. After `PUBLISHED`, every public
Maven file must match the signed inventory before the API 26 and API 35 public
consumer lanes run.

Do not move or recreate a published tag. If a released artifact or manifest is
wrong, fix the source and publish a new patch version with a new checksum.

## Consumer Requirements

iOS applications must include `NSBluetoothAlwaysUsageDescription`. Sandboxed
macOS applications must enable **App Sandbox > Hardware > Bluetooth**, which
sets `com.apple.security.device.bluetooth`; macOS applications should also
provide the Bluetooth usage description displayed to users.

The package contains no Bota backend API client. Host applications remain
responsible for backend grants, device tokens, and presigned upload targets.
