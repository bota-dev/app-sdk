# CocoaPods source migration

Bota continues to support CocoaPods through the public
[`bota-dev/cocoapods-specs`](https://github.com/bota-dev/cocoapods-specs)
repository. Configure this source explicitly when installing the Apple pod or
the native dependency of a Flutter application. Swift Package Manager remains an
independent supported route; this migration does not require switching to it.

## What changes

The index URL is `https://github.com/bota-dev/cocoapods-specs.git`. It contains
JSON specifications in CocoaPods' Git-spec-repository layout:

```text
Specs/BotaAppSDK/2.0.0-beta.22/BotaAppSDK.podspec.json
```

The pod name, exact SDK version and checksummed archive stay the same. The
specification still downloads the corresponding immutable archive from the
`bota-dev/app-sdk` GitHub Release. This repository stores the version index,
not another SDK implementation or a replacement binary build.

Historical 1.x packages retain the `BotaAppleSDK` name. Use the name belonging to
the selected release; do not rename a historical pod or combine independently
versioned Flutter and native packages. Existing CocoaPods central registrations
and historical installs are unchanged.

## Native Apple applications

Select the Bota source for the exact published version in your `Podfile`:

```ruby
source 'https://github.com/bota-dev/cocoapods-specs.git'
source 'https://cdn.cocoapods.org/'

platform :ios, '15.0'
use_frameworks!

target 'YourApp' do
  pod 'BotaAppSDK', '2.0.0-beta.22', :source => 'https://github.com/bota-dev/cocoapods-specs.git'
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
source 'https://github.com/bota-dev/cocoapods-specs.git'
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

The protected SDK release publisher appends the preserved release specification
to the Bota index only after checking its source, version, archive and checksum.
An existing version must match the complete canonical specification. A mismatch
stops the release; retries must not overwrite it or rebuild the original
archive.

For a new entry, the publisher stages the exact candidate on a unique branch
and opens a pull request. The exact head must pass Validate Specs, License Gate
and Scan. Organization policy requires at least one independent approval and
approval of the latest push, followed by an authorized merge. The publisher
waits for that merge and verifies the actual public specification on `main`.
It does not approve or merge its own pull request, push `main` directly, or
bypass repository rules.

The current publisher receives `BOTA_COCOAPODS_SPECS_TOKEN` from the SDK's
protected `release` environment. Provision an approved fine-grained token with
Contents write and Pull requests write access restricted to
`bota-dev/cocoapods-specs`. Required public check observations are anonymous. An approved GitHub App
integration may provide a short-lived repository installation token at execution
time instead. Track expiration, rotation and revocation. Neither this guide nor
a workflow reference establishes that the writer has actually been configured.
The writer secret is not configured, so automatic new-version publication is
not activated. An available index or passing consumer build is not evidence
that this publishing route is active.

Publication uses HTTPS with a per-command credential helper. Do not persist a
general user credential, introduce a deploy-key fallback around repository
policy, or commit credentials to this index. Applications and public-index
readers do not need the publisher token; never put it in a `Podfile`.

Qualification requires a clean Apple consumer and a real Flutter consumer,
using empty CocoaPods repositories/caches and the exact published version.
Check both the resolved version and Bota source in `Podfile.lock`, then compile
the applications. Index metadata, a successful `pod install` alone, or source
fixtures do not establish both consumer builds. These builds do not establish
physical-device, background-execution or enterprise-policy acceptance.

See the [release runbook](../releasing.md#package-name-migration) for the
preserved-artifact and synchronized-publication gates. Historical release
workflows retain their original central-registry checks; existing registrations
are not deleted or republished.
