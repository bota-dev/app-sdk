# Bota SDK for Android

This directory is the unpublished Android facade for the Bota App SDK family.
It produces `dev.bota:bota-android-sdk` from the synchronized version in the
repository root. The legacy Android repository remains a migration input until
the facade, physical-device, compatibility, and release gates pass.

## Toolchain

- JDK 17
- Gradle 8.13
- Android Gradle Plugin 8.13.2
- Kotlin 2.3.20
- Android API 26 minimum and API 36 compile, lint, and test target
- Android NDK 28.2.13676358
- CMake 3.22.1

Applications request Bluetooth runtime permissions. The library declares the
required permissions, including location for BLE scanning through API 30, and
the optional BLE hardware feature but never prompts the user itself.

## Verify

```bash
JAVA_HOME=/path/to/jdk-17 \
ANDROID_HOME="$HOME/Library/Android/sdk" \
npm --prefix ../.. run test:android:foundation
```

Normal builds can publish unsigned artifacts only to the `Local` repository at
`target/android-m2`. Remote publication and signing require the exact
`botaProtectedSigning=true` Gradle property and release-environment credentials.
`VERSION_NAME` must match the root `sdk-version.toml`; Gradle rejects an
override rather than producing a differently versioned artifact.
