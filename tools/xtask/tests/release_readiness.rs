use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_ANDROID_FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn android_build_fixture() -> PathBuf {
    let temp_root = std::env::temp_dir().join(format!(
        "bota-android-build-test-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT_ANDROID_FIXTURE_ID.fetch_add(1, Ordering::Relaxed),
    ));
    let android = temp_root.join("platforms/android");
    fs::create_dir_all(android.join("gradle/wrapper")).unwrap();
    fs::create_dir_all(android.join("sdk/src/main")).unwrap();
    for (source, destination) in [
        ("sdk-version.toml", "sdk-version.toml"),
        (
            "platforms/android/gradle.properties",
            "platforms/android/gradle.properties",
        ),
        (
            "platforms/android/gradle/libs.versions.toml",
            "platforms/android/gradle/libs.versions.toml",
        ),
        (
            "platforms/android/gradle/wrapper/gradle-wrapper.properties",
            "platforms/android/gradle/wrapper/gradle-wrapper.properties",
        ),
        (
            "platforms/android/gradle/wrapper/gradle-wrapper.jar",
            "platforms/android/gradle/wrapper/gradle-wrapper.jar",
        ),
        (
            "platforms/android/build.gradle.kts",
            "platforms/android/build.gradle.kts",
        ),
        (
            "platforms/android/sdk/build.gradle.kts",
            "platforms/android/sdk/build.gradle.kts",
        ),
        (
            "platforms/android/sdk/src/main/AndroidManifest.xml",
            "platforms/android/sdk/src/main/AndroidManifest.xml",
        ),
        (
            "platforms/android/sdk/gradle.lockfile",
            "platforms/android/sdk/gradle.lockfile",
        ),
    ] {
        let destination = temp_root.join(destination);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(root().join(source), destination).unwrap();
    }
    temp_root
}

#[test]
fn version_tag_and_publishable_metadata_are_synchronized() {
    let release = xtask::release::verify_release(&root(), "v1.1.0").unwrap();

    assert_eq!(release.version, "1.1.0");
    assert_eq!(release.crate_name, "bota-device-sdk-core");
}

#[test]
fn compatibility_metadata_reports_apple_and_the_android_release_candidate() {
    let path = root().join("protocol/compatibility/firmware-compatibility.json");
    let contents = fs::read_to_string(path).unwrap();
    let compatibility: serde_json::Value = serde_json::from_str(&contents).unwrap();

    assert_eq!(
        compatibility["nativeAbi"]["publishedFacades"],
        serde_json::json!(["apple"])
    );
    assert_eq!(
        compatibility["platformFacades"]["apple"]["publicationStatus"],
        "published"
    );
    assert_eq!(
        compatibility["platformFacades"]["apple"]["physicalDeviceStatus"],
        "physical_device_verified"
    );
    assert_eq!(
        compatibility["platformFacades"]["android"]["publicationStatus"],
        "release_candidate"
    );
    assert_eq!(
        compatibility["platformFacades"]["android"]["physicalDeviceStatus"],
        "physical_device_verified"
    );
}

#[test]
fn mismatched_or_unprefixed_tags_are_rejected() {
    let wrong_version = xtask::release::verify_release(&root(), "v1.0.0-alpha.1").unwrap_err();
    let missing_prefix = xtask::release::verify_release(&root(), "1.1.0").unwrap_err();

    assert!(wrong_version.contains("does not match"));
    assert!(missing_prefix.contains("must start with v"));
}

#[test]
fn ci_workflow_validates_the_current_release_manifest() {
    let release = xtask::release::verify_release(&root(), "v1.1.0").unwrap();
    let path = root().join(".github/workflows/ci.yml");
    let contents = fs::read_to_string(path).unwrap();
    let _: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();
    let expected = format!("release/examples/{}.json", release.version);

    assert!(contents.contains(&expected));
    assert!(!contents.contains("release/examples/1.0.0.json"));
}

#[test]
fn release_workflow_publishes_and_smokes_the_public_apple_package() {
    let path = root().join(".github/workflows/release.yml");
    let contents = fs::read_to_string(path).unwrap();
    let workflow: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();

    assert!(contents.contains("tags:"));
    assert!(contents.contains("workflow_dispatch"));
    assert!(contents.contains("contents: write"));
    assert!(contents.contains("environment: release"));
    assert!(contents.contains("fetch-depth: 0"));
    assert!(contents.contains("git merge-base --is-ancestor"));
    assert!(contents.contains("release verify-tag"));
    assert!(contents.contains("cargo deny check"));
    assert!(contents.contains("runs-on: macos-15"));
    assert!(contents.contains("tools/apple/test-package.sh"));
    assert!(contents.contains("tools/apple/test-consumer.sh"));
    assert!(contents.contains("generic/platform=iOS'"));
    assert!(contents.contains("generic/platform=iOS Simulator'"));
    assert!(contents.contains("-scheme BotaAppleSDK"));
    assert!(!contents.contains("-scheme BotaDeviceSDK"));
    assert!(contents.contains("tools/apple/package-release.sh"));
    assert!(contents.contains("tools/apple/test-remote-consumer.sh"));
    assert!(contents.contains("actions/upload-artifact@"));
    assert!(contents.contains("actions/download-artifact@"));
    assert!(contents.contains("target/apple-release/"));
    assert!(!contents.contains("secrets.CRATES_IO_TOKEN"));
    assert!(!contents.contains("cargo publish"));

    let apple_steps = workflow["jobs"]["apple"]["steps"].as_sequence().unwrap();
    let apple_commands = apple_steps
        .iter()
        .filter_map(|step| step["run"].as_str())
        .collect::<Vec<_>>();
    let install = apple_commands
        .iter()
        .position(|command| *command == "npm ci")
        .unwrap();
    let release_tests = apple_commands
        .iter()
        .position(|command| *command == "npm run test:release")
        .unwrap();
    assert!(install < release_tests);

    let smoke = fs::read_to_string(root().join("tools/apple/test-remote-consumer.sh")).unwrap();
    assert!(smoke.contains("swift build"));
    assert!(smoke.contains("--jobs 1"));
    assert!(smoke.contains("-Xswiftc -disable-batch-mode"));
    assert!(!smoke.contains("swift run"));
    assert!(!smoke.contains("--jobs 2"));
}

#[test]
fn release_workflow_packs_publishes_and_verifies_the_react_native_package() {
    let path = root().join(".github/workflows/release.yml");
    let contents = fs::read_to_string(path).unwrap();
    let workflow: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();

    let react_native = &workflow["jobs"]["react-native"];
    assert_eq!(react_native["runs-on"].as_str(), Some("ubuntu-latest"));
    let react_native_commands = react_native["steps"]
        .as_sequence()
        .unwrap()
        .iter()
        .filter_map(|step| step["run"].as_str())
        .collect::<Vec<_>>();
    assert!(
        react_native_commands
            .iter()
            .any(|command| command == &"npm ci")
    );
    assert!(
        react_native_commands
            .iter()
            .any(|command| command == &"npm run verify")
    );
    assert!(contents.contains("NPM_CLI_VERSION: \"12.0.2\""));
    assert!(contents.contains(
        "npx --yes \"npm@$NPM_CLI_VERSION\" pack --pack-destination ../../target/react-native-release"
    ));
    assert!(contents.contains("name: react-native-release-${{ github.ref_name }}"));
    assert!(contents.contains("path: target/react-native-release/"));

    let publish = &workflow["jobs"]["publish"];
    assert_eq!(publish["permissions"]["id-token"].as_str(), Some("write"));
    assert!(contents.contains("needs: [verify, apple, android, react-native]"));
    assert!(contents.contains("registry-url: https://registry.npmjs.org"));
    assert!(contents.contains("target/react-native-release"));
    assert!(
        contents.contains(
            "npx --yes \"npm@$NPM_CLI_VERSION\" publish \"$PACKAGE_PATH\" --access public --tag \"$NPM_DIST_TAG\""
        )
    );
    assert!(
        contents.contains("npx --yes \"npm@$NPM_CLI_VERSION\" view \"$PACKAGE_SPEC\" dist.shasum")
    );
    assert!(!contents.contains("NPM_TOKEN"));
    assert!(!contents.contains("NODE_AUTH_TOKEN"));
}

#[test]
fn android_ci_builds_once_and_verifies_both_supported_emulator_contracts() {
    let path = root().join(".github/workflows/ci.yml");
    let contents = fs::read_to_string(path).unwrap();
    let workflow: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();
    let emulator = fs::read_to_string(root().join("tools/android/test-emulator-lane.sh")).unwrap();
    let legacy_consumer =
        fs::read_to_string(root().join("tools/android/test-legacy-consumer.sh")).unwrap();

    assert!(contents.contains("Set up JDK 17"));
    assert!(contents.contains("platforms;android-36"));
    assert!(contents.contains("build-tools;35.0.0"));
    assert!(contents.contains("ndk;28.2.13676358"));
    assert!(contents.contains("cmake;3.22.1"));
    assert!(contents.contains(
        "aarch64-linux-android,armv7-linux-androideabi,x86_64-linux-android,i686-linux-android"
    ));
    assert!(contents.contains("system-images;android-26;google_apis;x86"));
    assert!(contents.contains("system-images;android-35;google_apis;x86_64"));
    assert!(emulator.contains("bota-api-26"));
    assert!(emulator.contains("bota-api-35"));
    assert!(emulator.contains("-no-window -no-audio -no-boot-anim"));
    assert!(emulator.contains("sys.boot_completed"));
    assert!(emulator.contains("window_animation_scale 0"));
    assert!(contents.contains("tools/android/test-emulator-lane.sh --api 26"));
    assert!(contents.contains("tools/android/test-emulator-lane.sh --api 35"));
    assert!(
        contents.contains("tools/android/test-legacy-consumer.sh --mode source --compile-only")
    );
    assert!(
        contents.contains("tools/android/test-legacy-consumer.sh --mode binary --compile-only")
    );
    assert!(contents.contains("tools/android/test-consumer.sh --compile-only"));
    assert!(emulator.contains("dev.bota.sdk.internal.jni.NativeCoreBridgeTest"));
    assert!(emulator.contains("dev.bota.sdk.internal.bluetooth.BluetoothPermissionTest"));
    assert!(emulator.contains("tools/android/test-legacy-consumer.sh"));
    assert!(emulator.contains("tools/android/test-consumer.sh"));
    assert!(legacy_consumer.contains("verify-legacy-consumer-fixture.sh"));
    assert!(contents.contains("tools/android/package-release.sh --check"));
    assert!(contents.contains("target/android-release/"));
    assert!(contents.contains("compression-level: 0"));
    assert!(emulator.contains("delete avd --name"));
    assert!(!contents.contains("botaProtectedSigning"));
    assert!(!contents.contains("signingInMemoryKey"));
    assert!(!contents.contains("CENTRAL_"));
    assert!(!contents.contains("uploadBundle"));
    assert!(!contents.contains("bota-mobile-sdk-android"));

    let android_steps = workflow["jobs"]["android-native"]["steps"]
        .as_sequence()
        .unwrap();
    let package_count = android_steps
        .iter()
        .filter_map(|step| step["run"].as_str())
        .filter(|command| command.contains("tools/android/package-release.sh --check"))
        .count();
    assert_eq!(package_count, 1);
}

#[test]
fn ci_emits_the_exact_release_candidate_inventory_used_for_tagging() {
    let path = root().join(".github/workflows/ci.yml");
    let contents = fs::read_to_string(path).unwrap();
    let workflow: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();

    assert_eq!(
        workflow["jobs"]["release-candidate"]["needs"],
        serde_yaml_ng::from_str::<serde_yaml_ng::Value>("[android-native, apple, react-native]")
            .unwrap()
    );
    assert!(contents.contains("name: react-native-ci-${{ github.sha }}"));
    assert!(contents.contains("name: android-ci-${{ github.sha }}"));
    assert!(contents.contains("name: apple-package-${{ github.sha }}"));
    assert!(contents.contains("tools/release/write-candidate-inventory.sh"));
    assert!(contents.contains("release-candidate-files.json.sha256"));
    assert!(contents.contains("name: release-candidate-${{ github.sha }}"));

    let react_native_steps = workflow["jobs"]["react-native"]["steps"]
        .as_sequence()
        .unwrap();
    assert!(
        react_native_steps
            .iter()
            .any(|step| step["name"].as_str() == Some("Install repository tooling"))
    );
}

#[test]
fn android_license_gate_checks_locked_verified_spdx_dependencies() {
    let path = root().join(".github/workflows/license-gate.yml");
    let contents = fs::read_to_string(path).unwrap();
    let _: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();

    assert!(contents.contains("platforms/android/sdk/gradle.lockfile"));
    assert!(contents.contains("platforms/android/settings-gradle.lockfile"));
    assert!(contents.contains("platforms/android/gradle/verification-metadata.xml"));
    assert!(contents.contains("tools/android/package-release.sh --check"));
    assert!(contents.contains("tools/android/verify-publication.sh target/android-release"));
    assert!(contents.contains("BotaAndroidSDK.spdx.json"));
    assert!(!contents.contains("signingInMemoryKey"));
    assert!(!contents.contains("CENTRAL_"));
}

#[test]
fn release_workflow_publishes_android_through_a_recoverable_central_deployment() {
    let path = root().join(".github/workflows/release.yml");
    let contents = fs::read_to_string(path).unwrap();
    let workflow: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();

    let android = &workflow["jobs"]["android"];
    assert_eq!(android["runs-on"].as_str(), Some("ubuntu-latest"));
    let android_steps = android["steps"].as_sequence().unwrap();
    let android_commands = android_steps
        .iter()
        .filter_map(|step| step["run"].as_str())
        .collect::<Vec<_>>();
    assert!(
        android_commands
            .iter()
            .any(|command| command.contains("tools/android/test-publication-graphs.sh"))
    );
    assert!(
        android_commands
            .iter()
            .any(|command| command.contains("tools/android/package-release.sh --check"))
    );
    assert!(
        android_commands.iter().any(|command| command
            .contains("cargo xtask release validate target/android-release/release-manifest.json"))
    );
    assert!(contents.contains("name: android-release-${{ github.ref_name }}"));
    assert!(contents.contains("path: target/android-release/"));
    assert!(contents.contains("workflow_dispatch:"));
    assert!(contents.contains("releaseRef:"));
    assert!(contents.contains("centralDeploymentId:"));
    assert!(contents.contains("centralRecoveryMode:"));
    assert!(contents.contains("releaseRunId:"));
    assert!(contents.contains("environment: release"));
    assert!(contents.contains("MAVEN_CENTRAL_USERNAME"));
    assert!(contents.contains("MAVEN_CENTRAL_PASSWORD"));
    assert!(contents.contains("SIGNING_IN_MEMORY_KEY"));
    assert!(contents.contains("SIGNING_IN_MEMORY_KEY_PASSWORD"));
    assert!(contents.contains("resolve-release-channel.mjs"));
    assert!(contents.contains("--mode new"));
    assert!(contents.contains("--mode recovery"));
    assert!(contents.contains("LATEST_BEFORE"));
    assert!(contents.contains("test \"$LATEST_AFTER\" = \"$LATEST_BEFORE\""));
    assert!(contents.contains("test \"$PUBLISHED_BETA\" = \"$RELEASE_VERSION\""));
    assert!(contents.contains("gh release edit \"$RELEASE_TAG\" --draft=false --prerelease"));
    assert!(!contents.contains("central-dev.bota-bota-android-sdk-1.1.0"));
    assert!(!contents.contains("--version 1.1.0"));
    assert!(!contents.contains("refs/tags/v1.1.0"));
    assert!(!contents.contains("PACKAGE_SPEC=\"@bota.dev/react-native-sdk@1.1.0\""));
    assert!(contents.contains("stageSignedCentralRawRepository"));
    assert!(contents.contains("central-portal.mjs prepare"));
    assert!(contents.contains("central-portal.mjs upload-or-resume"));
    assert!(contents.contains("central-portal.mjs recover-and-resume"));
    assert!(contents.contains("central-portal.mjs retry-failed"));
    assert!(contents.contains("central-portal.mjs verify-published"));
    assert!(contents.contains("unzip -q target/android-release/central-bundle.zip"));
    assert!(contents.contains("run-id: ${{ inputs.releaseRunId }}"));
    assert!(contents.contains("needs: [publish, recover-central]"));
    assert!(contents.contains("github.event_name == 'workflow_dispatch'"));
    assert!(contents.contains("central-portal-state.json"));
    assert!(contents.contains("central-bundle-files.json"));
    assert!(contents.contains("central-bundle.zip"));
    assert!(contents.contains("needs: [verify, apple, android, react-native]"));
    assert!(contents.contains("matrix:\n        api: [26, 35]"));
    assert!(contents.contains("tools/android/test-public-consumer.sh --api ${{ matrix.api }}"));
    assert!(!contents.contains("echo \"published=false\""));
}

#[test]
fn release_workflow_never_publishes_npm_without_the_beta_tag() {
    let contents = fs::read_to_string(root().join(".github/workflows/release.yml")).unwrap();
    let npm_publish_lines = contents
        .lines()
        .filter(|line| line.contains("npm@$NPM_CLI_VERSION") && line.contains(" publish "))
        .collect::<Vec<_>>();

    assert_eq!(npm_publish_lines.len(), 2);
    for line in npm_publish_lines {
        assert!(line.contains("--tag \"$NPM_DIST_TAG\""), "{line}");
    }
}

#[test]
fn android_build_authorities_are_synchronized() {
    let result = xtask::release::verify_android_build(&root());

    assert!(result.is_ok(), "{result:?}");
}

#[test]
fn android_javadoc_publication_excludes_dokka_nondeterminism() {
    let build = fs::read_to_string(root().join("platforms/android/sdk/build.gradle.kts")).unwrap();

    assert!(build.contains("tasks.withType<Jar>().matching { it.name == \"javaDocReleaseJar\" }"));
    assert!(build.contains("exclude(\"deprecated.html\")"));
}

#[test]
fn android_native_artifacts_require_16_kib_page_alignment() {
    let build_native = fs::read_to_string(root().join("tools/android/build-native.sh")).unwrap();
    let inspect_aar = fs::read_to_string(root().join("tools/android/inspect-aar.sh")).unwrap();
    let cmake =
        fs::read_to_string(root().join("platforms/android/sdk/src/main/cpp/CMakeLists.txt"))
            .unwrap();

    assert!(build_native.contains("-Wl,-z,max-page-size=16384"));
    assert!(build_native.contains("-Wl,-z,common-page-size=16384"));
    assert!(cmake.contains("-Wl,-z,max-page-size=16384"));
    assert!(cmake.contains("-Wl,-z,common-page-size=16384"));
    assert!(inspect_aar.contains("--program-headers"));
    assert!(inspect_aar.contains("0x4000"));
}

#[test]
fn android_release_inputs_are_hardened_and_locked() {
    let android = root().join("platforms/android");
    let build = fs::read_to_string(android.join("build.gradle.kts")).unwrap();
    let sdk_build = fs::read_to_string(android.join("sdk/build.gradle.kts")).unwrap();
    let wrapper =
        fs::read_to_string(android.join("gradle/wrapper/gradle-wrapper.properties")).unwrap();
    let manifest = fs::read_to_string(android.join("sdk/src/main/AndroidManifest.xml")).unwrap();
    let lock = fs::read_to_string(android.join("sdk/gradle.lockfile")).unwrap();
    let verification =
        fs::read_to_string(android.join("gradle/verification-metadata.xml")).unwrap();

    assert!(build.contains("configuredSdkVersion == canonicalSdkVersion"));
    assert_eq!(sdk_build.matches("targetSdk = 36").count(), 2);
    assert!(sdk_build.contains("lockMode.set(LockMode.STRICT)"));
    assert!(wrapper.contains(
        "distributionSha256Sum=20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78"
    ));
    assert!(manifest.contains(
        "android:name=\"android.permission.ACCESS_FINE_LOCATION\"\n        android:maxSdkVersion=\"30\""
    ));
    assert!(lock.contains("androidx.test:core:1.7.0"));
    assert!(lock.contains("androidx.test:runner:1.7.0"));
    assert!(lock.contains("androidx.test.ext:junit:1.3.0"));
    assert!(verification.contains("aapt2-8.13.2-14304508-linux.jar"));
    assert!(
        verification.contains("839609d6d776d6dd60a02aa577d97193ce3e650cf1deaabf062321e23bbd6bf6")
    );
    for artifact in [
        "guava-parent-33.3.1-jre.pom",
        "jackson-base-2.15.3.pom",
        "junit-bom-5.10.2.module",
        "kotlinx-coroutines-bom-1.8.0.pom",
    ] {
        assert!(
            verification.contains(artifact),
            "Gradle verification metadata is missing {artifact}"
        );
    }
}

#[test]
fn android_publishing_plugin_cannot_cross_the_gradle_8_floor() {
    let temp_root = android_build_fixture();
    let android = temp_root.join("platforms/android");
    let catalog_path = root().join("platforms/android/gradle/libs.versions.toml");
    let catalog = fs::read_to_string(catalog_path)
        .unwrap()
        .replace("mavenPublish = \"0.35.0\"", "mavenPublish = \"0.36.0\"");
    fs::write(android.join("gradle/libs.versions.toml"), catalog).unwrap();

    let result = xtask::release::verify_android_build(&temp_root);
    fs::remove_dir_all(temp_root).unwrap();

    assert!(
        result
            .unwrap_err()
            .contains("must remain 0.35.0 with Gradle 8")
    );
}

#[test]
fn android_wrapper_checksum_is_enforced() {
    let temp_root = android_build_fixture();
    let wrapper_path = temp_root.join("platforms/android/gradle/wrapper/gradle-wrapper.properties");
    let wrapper = fs::read_to_string(&wrapper_path).unwrap().replace(
        "20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78",
        "0000000000000000000000000000000000000000000000000000000000000000",
    );
    fs::write(wrapper_path, wrapper).unwrap();

    let result = xtask::release::verify_android_build(&temp_root);
    fs::remove_dir_all(temp_root).unwrap();

    assert!(result.unwrap_err().contains("checksum must match"));
}

#[test]
fn android_wrapper_jar_checksum_is_enforced() {
    let temp_root = android_build_fixture();
    let wrapper_jar = temp_root.join("platforms/android/gradle/wrapper/gradle-wrapper.jar");
    let mut bytes = fs::read(&wrapper_jar).unwrap();
    bytes[0] ^= 0xff;
    fs::write(wrapper_jar, bytes).unwrap();

    let result = xtask::release::verify_android_build(&temp_root);
    fs::remove_dir_all(temp_root).unwrap();

    assert!(result.unwrap_err().contains("wrapper JAR checksum"));
}

#[test]
fn android_wrapper_security_properties_must_be_unique() {
    for duplicate in [
        "distributionUrl=https\\://example.invalid/gradle-8.13-bin.zip",
        "distributionUrl = https\\://example.invalid/gradle-8.13-bin.zip",
        "distributionUrl:https\\://example.invalid/gradle-8.13-bin.zip",
        "distribution\\Url=https\\://example.invalid/gradle-8.13-bin.zip",
        "distributionUr\\\nl=https\\://example.invalid/gradle-8.13-bin.zip",
    ] {
        let temp_root = android_build_fixture();
        let wrapper_path =
            temp_root.join("platforms/android/gradle/wrapper/gradle-wrapper.properties");
        let mut wrapper = fs::read_to_string(&wrapper_path).unwrap();
        wrapper.push_str(&format!("\n{duplicate}\n"));
        fs::write(wrapper_path, wrapper).unwrap();

        let result = xtask::release::verify_android_build(&temp_root);
        fs::remove_dir_all(temp_root).unwrap();

        let error = result.unwrap_err();
        assert!(
            error.contains("must not be repeated")
                || error.contains("canonical key=value syntax")
                || error.contains("must not use continuations"),
            "{error}"
        );
    }
}
