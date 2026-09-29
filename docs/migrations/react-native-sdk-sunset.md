# Standalone React Native SDK retirement

Maintenance of `@bota.dev/react-native-sdk` ended on September 29, 2026.
The replacement is `@bota.dev/react-native-app-sdk`, currently `2.0.0-beta.7`.
This is an explicit retirement decision while the replacement remains a
prerelease; it does not promote App SDK to stable.

Existing old package versions, dist-tags and source history are retained.
Retirement does not replace installed applications or alter package tarballs.
The old `latest` (`0.0.67`) and historical `beta` (`1.2.0-beta.11`) are both
retired; neither tag redirects to the new package name.

Follow [the package migration guide](app-sdk-package-names.md), update imports,
and rebuild the native application. Do not co-install both facades. Review
[maintenance parity and compatibility limits](../parity/maintenance-baseline.md):
native-owned files and callbacks replace legacy JS byte stores, and native
encrypted-v2 workflows replace the old byte-oriented integration. A package-name
change alone is not a complete host integration.

Demo 1.0.10, Bota One 1.0.7 and the public React Native example already consume
the verified App SDK beta.6 runtime. Beta.7 changes publication tooling and
synchronized identity, so those binaries remain valid. All five beta.7 package
families and their public installation checks passed in
[release 36518738086](https://github.com/bota-dev/app-sdk/actions/runs/36518738086).
Physical iPhone acceptance remains deferred. External customer migration status
is not established by first-party rollout evidence.

The old repository retains issues
[#1](https://github.com/bota-dev/react-native-sdk/issues/1),
[#2](https://github.com/bota-dev/react-native-sdk/issues/2) and
[#3](https://github.com/bota-dev/react-native-sdk/issues/3) as historical reports.
Retirement does not mark them fixed. File current SDK reports in the
[App SDK tracker](https://github.com/bota-dev/app-sdk/issues).

## Review

| Requirement | Evidence and status |
| --- | --- |
| Clear replacement and native migration | Exact package/version, rebuild steps and compatibility links above; matched |
| Preserve existing artifacts | Deprecation and repository archival only; no unpublish, new legacy version or dist-tag reassignment is part of this retirement |
| First-party consumer migration | Released Demo/Bota One binaries and migrated example; matched for those consumers |
| Stable successor before retirement | Intentionally diverged: owner authorized retirement on September 29 while App SDK remains beta |
| External migration and physical acceptance | External migration unverified; physical iPhone testing deferred; no complete-parity claim |

This dated decision supersedes the old plan's stable-before-deprecation rule
for the standalone React Native package only. Legacy Apple and Android
repositories are outside this retirement.
