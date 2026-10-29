# CocoaPods source migration

Bota's CocoaPods index belongs in [`Specs/`](../../Specs/) in the same public
[`bota-dev/app-sdk`](https://github.com/bota-dev/app-sdk) repository as the SDK
source. This migration retains CocoaPods for the Apple pod and the native
dependency of Flutter applications. Swift Package Manager remains an independent
supported route; this migration does not require switching to it.

The bootstrap and publisher changes are awaiting integration, exact-main
qualification and activation. The installation examples below describe the
source after its Specs bootstrap is merged and qualified on `main`. A candidate
branch passing CI does not establish default-source availability, and this guide
does not announce a new package release or active publication service.

## What changes

The canonical index URL is `https://github.com/bota-dev/app-sdk.git`. Its
`Specs/` directory contains JSON specifications in CocoaPods' Git-spec-repository
layout:

```text
Specs/BotaAppSDK/2.0.0-beta.22/BotaAppSDK.podspec.json
```

The pod name, exact SDK version and checksummed archive stay the same. The
specification still downloads the corresponding immutable archive from the
`bota-dev/app-sdk` GitHub Release. The Specs directory stores version metadata;
moving the index neither duplicates the SDK implementation nor rebuilds binaries.

Historical 1.x packages retain the `BotaAppleSDK` name. Use the name belonging to
the selected release; do not rename a historical pod or combine independently
versioned Flutter and native packages. Existing CocoaPods central registrations
and historical installs are unchanged.

## Native Apple applications

Select the Bota source for the exact published version in your `Podfile`:

```ruby
source 'https://github.com/bota-dev/app-sdk.git'
source 'https://cdn.cocoapods.org/'

platform :ios, '15.0'
use_frameworks!

target 'YourApp' do
  pod 'BotaAppSDK', '2.0.0-beta.22', :source => 'https://github.com/bota-dev/app-sdk.git'
end
```

The official CDN can continue resolving other dependencies. Pin the SDK version
to one published in the Bota index and supported by your application. Keep the
Bluetooth permissions and other platform setup from the Apple integration
guide; changing the package source does not configure the device or grant
runtime permissions.

## Flutter applications

Keep the exact `bota_app_sdk` version in `pubspec.yaml`, selecting a version
already published in both the Flutter package registry and Bota Specs. Add these source
declarations to the top of the application's existing `ios/Podfile`, before the
Flutter-generated dependency setup:

```ruby
source 'https://github.com/bota-dev/app-sdk.git'
source 'https://cdn.cocoapods.org/'
```

Retain the existing Flutter helper and `flutter_install_all_ios_pods` call. The
plugin's podspec continues to require the exact same-version `BotaAppSDK`; do
not replace that dependency with a local SDK path or edit the downloaded plugin.
Follow the [Flutter platform setup](../../frameworks/flutter/bota_app_sdk/README.md#platform-setup)
for deployment targets and permissions.

## Existing lockfiles

Commit and preserve `Podfile.lock`. For the initial source change, keep the SDK
version pinned and update only the selected Bota pod's resolution:

```sh
pod update BotaAppSDK --repo-update
```

Use the historical pod name instead when migrating a supported 1.x package.
Review the resulting lockfile: the Bota pod must retain the selected version,
and its `SPEC REPOS` entry must identify the Bota Specs Git source. Subsequent
installs use the normal `pod install --repo-update` command and the committed
lockfile. Do not delete the entire lockfile or update every dependency merely
to change this source.

A local-path, direct Git or direct podspec installation can be useful for source
development, but does not verify that a named pod resolves from the Bota index.

## React Native integration

The native React Native compatibility adapter currently links the Apple SDK
through its existing exact-version SwiftPM integration. Its npm package and
autolinking contract are unchanged by this CocoaPods index migration.
Applications using the generated `/runtime` factory over their own OS ports
also retain that route. Inspect the application's actual native dependencies;
do not add another Apple SDK copy just to configure the Bota Specs source.

## Customer-approved sources and mirrors

Bota Specs is maintained by Bota. It is **not the CocoaPods central Specs
registry**, and availability here does not imply central registration or an
Apple/CocoaPods security review. Enterprises requiring a central registration
must approve the new source or continue using their already-approved historical
versions under their own support policy.

A customer may maintain an approved internal Specs mirror. Copy the selected
immutable JSON specification without changing its name, version, archive URL or
SHA-256, configure that approved source in the application, and verify the
lockfile identifies it. If downloading the original archive is also prohibited,
artifact ingestion and any rewritten specification need a separately reviewed
customer distribution policy; they are not an identical mirror of Bota's spec.
Never modify a published name/version in place to redirect consumers to new
bytes.

## Release and verification requirements

For the new route, the tag workflow must create a real production deployment
request through Bota Releases and wait for its Slack approval before publishing.
The signed execution receipt must bind the repository, release tag and tag
object, source revision, original release run and attempt, successful main CI
run and attempt, preserved artifact inventory digest and approval identity.
Publishers refresh and verify that binding before promotion. A Slack message
alone, approval for another attempt or an unverified callback cannot authorize
publication.

The approved SDK publisher appends the preserved release specification under
`Specs/` only after checking its source, version, archive and checksum. An
existing version must match the complete canonical specification. A mismatch
stops the release; retries must not overwrite it or rebuild the original archive.

For a new entry, the publisher stages the exact candidate on a unique branch
and opens a pull request in `bota-dev/app-sdk`. The exact head must pass Validate
Specs, Dependency licenses and Scan, plus the repository's required checks.
Organization policy requires at least one independent approval and approval of
the latest push, followed by an authorized merge. This GitHub source review is
distinct from Slack approval to release the preserved SDK candidate. The
publisher waits for the actual merge and verifies the public specification on
`main`. It does not approve or merge its own pull request, push `main` directly,
or bypass repository rules.

The approved publisher uses the SDK job's built-in `GITHUB_TOKEN`, exposed only
as `GH_TOKEN`, with Contents write, Pull requests write and Actions write in this
repository. Actions write explicitly dispatches validators for the staged
commit, because token-generated pushes do not automatically trigger them.
Publication uses HTTPS with a per-command credential helper. No cross-repository
PAT, deploy key or persisted general user credential is required. Applications
and public-index readers need no publisher credential; never put one in a
`Podfile`.

The SDK approval policy and Bota Releases SDK unit remain disabled, the Slack
activation variable is not enabled, and Actions pull-request creation remains
disabled pending reviewed setup. New-version publication through this route is
not activated. Review and qualify the bootstrap and release/service changes,
enable only the required Actions PR setting, and verify the actual signed Slack
request/approval flow before enabling publication. Preserve the historical
`release-approval` gate and historical tagged workflows; their presence does
not establish activation of this new route.

Qualification requires a clean Apple consumer and a real Flutter consumer,
using empty CocoaPods repositories/caches and the exact published version.
Check both the resolved version and Bota source in `Podfile.lock`, then compile
the applications. During bootstrap CI, an explicitly named branch and full
commit may qualify the candidate Specs. Repeat the consumers against default
`main` after integration; branch results cannot replace that gate. Index
metadata, a successful `pod install` alone, or source fixtures do not establish
both consumer builds. These builds do not establish physical-device,
background-execution or enterprise-policy acceptance.

See the [release runbook](../releasing.md#package-name-migration) for the
preserved-artifact and synchronized-publication gates. Historical release
workflows retain their original central-registry checks; existing registrations
are not deleted or republished.
