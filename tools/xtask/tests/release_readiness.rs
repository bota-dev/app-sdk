use std::{fs, path::PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn android_build_fixture() -> PathBuf {
    let temp_root = std::env::temp_dir().join(format!(
        "bota-android-build-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
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
    let release = xtask::release::verify_release(&root(), "v1.0.2").unwrap();

    assert_eq!(release.version, "1.0.2");
    assert_eq!(release.crate_name, "bota-device-sdk-core");
}

#[test]
fn compatibility_metadata_reports_the_public_apple_facade() {
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
        "not_run"
    );
}

#[test]
fn mismatched_or_unprefixed_tags_are_rejected() {
    let wrong_version = xtask::release::verify_release(&root(), "v1.0.0-alpha.1").unwrap_err();
    let missing_prefix = xtask::release::verify_release(&root(), "1.0.2").unwrap_err();

    assert!(wrong_version.contains("does not match"));
    assert!(missing_prefix.contains("must start with v"));
}

#[test]
fn ci_workflow_validates_the_current_release_manifest() {
    let release = xtask::release::verify_release(&root(), "v1.0.2").unwrap();
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
    assert!(!contents.contains("workflow_dispatch"));
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
fn android_build_authorities_are_synchronized() {
    let result = xtask::release::verify_android_build(&root());

    assert!(result.is_ok(), "{result:?}");
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
