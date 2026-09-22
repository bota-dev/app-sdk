use std::{
    fs,
    path::PathBuf,
    process::Command,
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

fn release_metadata_fixture() -> PathBuf {
    let temp_root = std::env::temp_dir().join(format!(
        "bota-release-metadata-test-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT_ANDROID_FIXTURE_ID.fetch_add(1, Ordering::Relaxed),
    ));
    for path in [
        "sdk-version.toml",
        "package.json",
        "package-lock.json",
        "core/device-sdk-core/Cargo.toml",
        "core/device-sdk-core/README.md",
        "tools/xtask/Cargo.toml",
        "frameworks/react-native/package.json",
        "frameworks/react-native/package-lock.json",
        "frameworks/web/package.json",
        "frameworks/flutter/bota_flutter_sdk/pubspec.yaml",
        "frameworks/flutter/bota_flutter_sdk/android/sdk-version.toml",
        "frameworks/flutter/bota_flutter_sdk/ios/bota_flutter_sdk/Package.swift",
        "platforms/android/gradle.properties",
        "platforms/apple/BotaAppleSDK.podspec",
        "protocol/compatibility/firmware-compatibility.json",
        "release/examples/1.2.0-beta.2.json",
    ] {
        let destination = temp_root.join(path);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::copy(root().join(path), destination).unwrap();
    }
    temp_root
}

fn occupied_flutter_release_fixture() -> PathBuf {
    let temp_root = std::env::temp_dir().join(format!(
        "bota-flutter-occupied-release-test-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT_ANDROID_FIXTURE_ID.fetch_add(1, Ordering::Relaxed),
    ));
    let script = temp_root.join("tools/flutter/package-release.sh");
    fs::create_dir_all(script.parent().unwrap()).unwrap();
    fs::copy(root().join("tools/flutter/package-release.sh"), &script).unwrap();
    fs::write(
        temp_root.join("sdk-version.toml"),
        "version = \"1.2.0-beta.0\"\n",
    )
    .unwrap();

    for args in [
        vec!["init", "--quiet"],
        vec!["config", "user.email", "test@example.com"],
        vec!["config", "user.name", "Release Test"],
        vec!["add", "."],
        vec!["commit", "--quiet", "-m", "fixture"],
    ] {
        let status = Command::new("git")
            .args(args)
            .current_dir(&temp_root)
            .status()
            .unwrap();
        assert!(status.success());
    }

    temp_root
}

#[test]
fn version_tag_and_publishable_metadata_are_synchronized() {
    let release = xtask::release::verify_release(&root(), "v1.2.0-beta.2").unwrap();

    assert_eq!(release.version, "1.2.0-beta.2");
    assert_eq!(release.crate_name, "bota-device-sdk-core");
}

#[test]
fn every_public_package_version_copy_fails_closed_on_drift() {
    for (path, needle, replacement) in [
        (
            "package-lock.json",
            "\"version\": \"1.2.0-beta.2\"",
            "\"version\": \"1.2.0-beta.3\"",
        ),
        (
            "frameworks/react-native/package.json",
            "\"version\": \"1.2.0-beta.2\"",
            "\"version\": \"1.2.0-beta.3\"",
        ),
        (
            "frameworks/react-native/package-lock.json",
            "\"version\": \"1.2.0-beta.2\"",
            "\"version\": \"1.2.0-beta.3\"",
        ),
        (
            "frameworks/web/package.json",
            "\"version\": \"1.2.0-beta.2\"",
            "\"version\": \"1.2.0-beta.3\"",
        ),
        (
            "frameworks/flutter/bota_flutter_sdk/pubspec.yaml",
            "version: 1.2.0-beta.2",
            "version: 1.2.0-beta.3",
        ),
        (
            "frameworks/flutter/bota_flutter_sdk/ios/bota_flutter_sdk/Package.swift",
            "exact: \"1.2.0-beta.2\"",
            "exact: \"1.2.0-beta.3\"",
        ),
        (
            "platforms/android/gradle.properties",
            "VERSION_NAME=1.2.0-beta.2",
            "VERSION_NAME=1.2.0-beta.3",
        ),
        (
            "platforms/apple/BotaAppleSDK.podspec",
            "spec.version = \"1.2.0-beta.2\"",
            "spec.version = \"1.2.0-beta.3\"",
        ),
    ] {
        let fixture = release_metadata_fixture();
        let target = fixture.join(path);
        let contents = fs::read_to_string(&target).unwrap();
        assert!(contents.contains(needle));
        fs::write(&target, contents.replacen(needle, replacement, 1)).unwrap();

        let error = xtask::release::verify_release(&fixture, "v1.2.0-beta.2").unwrap_err();
        assert!(
            error.contains("version") || error.contains("Version"),
            "{path}: {error}"
        );
        fs::remove_dir_all(fixture).unwrap();
    }
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
    let missing_prefix = xtask::release::verify_release(&root(), "1.2.0-beta.2").unwrap_err();

    assert!(wrong_version.contains("does not match"));
    assert!(missing_prefix.contains("must start with v"));
}

#[test]
fn ci_workflow_validates_the_current_release_manifest() {
    let release = xtask::release::verify_release(&root(), "v1.2.0-beta.2").unwrap();
    let path = root().join(".github/workflows/ci.yml");
    let contents = fs::read_to_string(path).unwrap();
    let _: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();
    let expected = format!("release/examples/{}.json", release.version);

    assert!(contents.contains(&expected));
    assert!(!contents.contains("release/examples/1.0.0.json"));
}

#[test]
fn verification_workflows_cover_pull_requests_and_main_without_cancelling_main() {
    for path in [
        ".github/workflows/ci.yml",
        ".github/workflows/license-gate.yml",
    ] {
        let contents = fs::read_to_string(root().join(path)).unwrap();
        let workflow: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();
        let triggers = workflow["on"].as_mapping().unwrap();

        assert_eq!(
            triggers.len(),
            3,
            "{path} must expose exactly three triggers"
        );
        for trigger in ["workflow_dispatch", "pull_request", "push"] {
            assert!(
                triggers.contains_key(serde_yaml_ng::Value::String(trigger.to_owned())),
                "{path} must expose {trigger}"
            );
        }
        assert_eq!(
            workflow["on"]["push"]["branches"],
            serde_yaml_ng::from_str::<serde_yaml_ng::Value>("[main]").unwrap(),
            "{path} must run on main pushes"
        );
    }

    let contents = fs::read_to_string(root().join(".github/workflows/ci.yml")).unwrap();
    let workflow: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();
    assert_eq!(
        workflow["concurrency"]["group"].as_str(),
        Some("${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}")
    );
    assert_eq!(
        workflow["concurrency"]["cancel-in-progress"].as_str(),
        Some("${{ github.event_name == 'pull_request' }}")
    );
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
    assert!(contents.contains("needs: [verify, apple, android, react-native, web]"));
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
fn web_package_version_and_release_artifact_are_synchronized() {
    let sdk_version: toml::Value =
        toml::from_str(&fs::read_to_string(root().join("sdk-version.toml")).unwrap()).unwrap();
    let expected = sdk_version["version"].as_str().unwrap();
    let package: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root().join("frameworks/web/package.json")).unwrap(),
    )
    .unwrap();
    let manifest: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(
            root()
                .join("release/examples")
                .join(format!("{expected}.json")),
        )
        .unwrap(),
    )
    .unwrap();

    assert_eq!(package["version"], expected);
    assert!(
        manifest["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|artifact| {
                artifact["platform"] == "web"
                    && artifact["packageIdentifier"] == "@bota.dev/web-sdk"
                    && artifact["version"] == expected
            })
    );
}

#[test]
fn workflows_build_and_preserve_the_exact_web_candidate() {
    let ci_contents = fs::read_to_string(root().join(".github/workflows/ci.yml")).unwrap();
    let ci: serde_yaml_ng::Value = serde_yaml_ng::from_str(&ci_contents).unwrap();
    assert_eq!(ci["jobs"]["web"]["runs-on"].as_str(), Some("ubuntu-latest"));
    assert!(ci_contents.contains("npm run web:verify"));
    assert!(ci_contents.contains("name: web-ci-${{ github.sha }}"));
    assert!(ci_contents.contains("path: target/web-release/"));
    assert_eq!(
        ci["jobs"]["release-candidate"]["needs"],
        serde_yaml_ng::from_str::<serde_yaml_ng::Value>(
            "[android-native, apple, react-native, web, flutter]"
        )
        .unwrap()
    );
    let ci_inventory_command = ci["jobs"]["release-candidate"]["steps"]
        .as_sequence()
        .unwrap()
        .iter()
        .find(|step| step["name"] == "Write candidate inventory")
        .unwrap()["run"]
        .as_str()
        .unwrap();
    assert!(ci_inventory_command.contains("target/web-release"));
    assert!(ci_inventory_command.contains("\"${candidate_roots[@]}\""));

    let release_contents =
        fs::read_to_string(root().join(".github/workflows/release.yml")).unwrap();
    let release: serde_yaml_ng::Value = serde_yaml_ng::from_str(&release_contents).unwrap();
    assert_eq!(
        release["jobs"]["web"]["runs-on"].as_str(),
        Some("ubuntu-latest")
    );
    assert!(release_contents.contains("name: web-release-${{ github.ref_name }}"));
    assert!(release_contents.contains("path: target/web-release/"));
    assert!(release_contents.contains("@bota.dev/web-sdk@$RELEASE_VERSION"));
    let inventory_command = release["jobs"]["publish"]["steps"]
        .as_sequence()
        .unwrap()
        .iter()
        .find(|step| step["name"] == "Verify annotated tag and candidate inventory")
        .unwrap()["run"]
        .as_str()
        .unwrap();
    assert!(inventory_command.contains("target/web-release"));
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
        serde_yaml_ng::from_str::<serde_yaml_ng::Value>(
            "[android-native, apple, react-native, web, flutter]"
        )
        .unwrap()
    );
    assert!(contents.contains("name: react-native-ci-${{ github.sha }}"));
    assert!(contents.contains("name: android-ci-${{ github.sha }}"));
    assert!(contents.contains("name: apple-package-${{ github.sha }}"));
    assert!(contents.contains("name: flutter-ci-${{ github.sha }}"));
    assert!(contents.contains("path: target/flutter-release/"));
    assert!(contents.contains("name: web-ci-${{ github.sha }}"));
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
fn flutter_ci_verifies_occupied_versions_and_only_uploads_releasable_candidates() {
    let contents = fs::read_to_string(root().join(".github/workflows/ci.yml")).unwrap();
    let workflow: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();
    let flutter = &workflow["jobs"]["flutter"];

    assert_eq!(flutter["runs-on"].as_str(), Some("macos-15"));
    assert_eq!(
        flutter["outputs"]["candidate-ready"].as_str(),
        Some("${{ steps.package.outputs.candidate-ready }}")
    );
    let steps = flutter["steps"].as_sequence().unwrap();
    let package = steps
        .iter()
        .find(|step| step["id"].as_str() == Some("package"))
        .unwrap();
    assert_eq!(
        package["run"].as_str(),
        Some("tools/flutter/package-release.sh --ci")
    );

    for name in [
        "Verify preserved Flutter candidate",
        "Upload Flutter candidate",
    ] {
        let step = steps
            .iter()
            .find(|step| step["name"].as_str() == Some(name))
            .unwrap();
        assert_eq!(
            step["if"].as_str(),
            Some("steps.package.outputs.candidate-ready == 'true'"),
            "{name}"
        );
    }

    let candidate_steps = workflow["jobs"]["release-candidate"]["steps"]
        .as_sequence()
        .unwrap();
    let download = candidate_steps
        .iter()
        .find(|step| step["name"].as_str() == Some("Download Flutter candidate"))
        .unwrap();
    assert_eq!(
        download["if"].as_str(),
        Some("needs.flutter.outputs.candidate-ready == 'true'")
    );
    let inventory = candidate_steps
        .iter()
        .find(|step| step["name"].as_str() == Some("Write candidate inventory"))
        .unwrap();
    assert_eq!(
        inventory["env"]["FLUTTER_CANDIDATE_READY"].as_str(),
        Some("${{ needs.flutter.outputs.candidate-ready }}")
    );
    let inventory_command = inventory["run"].as_str().unwrap();
    assert!(inventory_command.contains("candidate_roots=("));
    assert!(inventory_command.contains("candidate_roots+=(target/flutter-release)"));
    assert!(inventory_command.contains("\"${candidate_roots[@]}\""));
}

#[test]
fn flutter_candidate_tooling_refuses_the_occupied_beta_zero_identity() {
    let contents = fs::read_to_string(root().join("tools/flutter/package-release.sh")).unwrap();
    let fixture = occupied_flutter_release_fixture();
    let output = Command::new("bash")
        .arg(fixture.join("tools/flutter/package-release.sh"))
        .arg("--check")
        .output()
        .unwrap();

    fs::remove_dir_all(fixture).unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "Flutter release version 1.2.0-beta.0 is occupied by an immutable tag and must not be reused\n"
    );
    assert!(contents.contains("OCCUPIED_VERSION=\"1.2.0-beta.0\""));
    assert!(contents.contains("release/examples/$sdk_version.json"));
    assert!(contents.contains("is occupied by an immutable tag"));
    assert!(!contents.contains("EXAMPLE_MANIFEST=\"$ROOT/release/examples/1.2.0-beta.0.json\""));
    assert!(!contents.contains("$sdk_version\" != \"1.2.0-beta.0"));
}

#[test]
fn primary_operator_docs_mark_beta_zero_occupied() {
    for path in ["README.md", "docs/releasing.md"] {
        let contents = fs::read_to_string(root().join(path)).unwrap();
        assert!(contents.contains("`1.2.0-beta.0` is occupied"), "{path}");
        assert!(
            contents.contains("must not be reused"),
            "{path} must forbid reuse"
        );
    }
}

#[test]
fn flutter_release_is_ordered_after_public_native_dependencies_and_verified_before_completion() {
    let contents = fs::read_to_string(root().join(".github/workflows/release.yml")).unwrap();
    let workflow: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();

    assert_eq!(
        workflow["jobs"]["publish-apple-pod"]["needs"].as_str(),
        Some("publish")
    );
    assert_eq!(
        workflow["jobs"]["publish-apple-pod"]["uses"].as_str(),
        Some("./.github/workflows/publish-apple-pod.yml")
    );
    assert_eq!(
        workflow["jobs"]["flutter"]["needs"],
        serde_yaml_ng::from_str::<serde_yaml_ng::Value>(
            "[publish, publish-apple-pod, smoke-public-package, smoke-public-android]"
        )
        .unwrap()
    );
    assert!(contents.contains("tools/apple/test-remote-consumer.sh"));
    assert!(contents.contains("tools/flutter/test-public-apple-pod-consumer.sh"));
    assert!(contents.contains("tools/android/test-consumer.sh --public --compile-only"));
    assert!(contents.contains("tools/flutter/package-release.sh --check"));
    assert!(contents.contains("name: flutter-release-${{ github.ref_name }}"));

    let bootstrap = &workflow["jobs"]["verify-flutter-publication"];
    assert_eq!(bootstrap["needs"].as_str(), Some("flutter"));
    assert_eq!(bootstrap["environment"].as_str(), Some("release"));
    let bootstrap_source = serde_yaml_ng::to_string(bootstrap).unwrap();
    assert!(!bootstrap_source.contains("flutter pub publish"));
    assert!(!bootstrap_source.contains("v1.2.0-beta.0"));
    assert!(bootstrap_source.contains("verify-publication.mjs verify-public"));
    assert!(bootstrap_source.contains("api/archives/bota_flutter_sdk-"));
    assert!(
        bootstrap["steps"]
            .as_sequence()
            .unwrap()
            .iter()
            .all(|step| step["name"].as_str() != Some("Print protected first-publish command"))
    );

    let complete = &workflow["jobs"]["complete-release"];
    assert_eq!(
        complete["needs"].as_str(),
        Some("verify-flutter-publication")
    );
    assert!(
        serde_yaml_ng::to_string(complete)
            .unwrap()
            .contains("gh release")
    );
}

#[test]
fn tag_and_recovery_workflows_bind_native_and_flutter_outputs_to_the_ci_candidate() {
    let contents = fs::read_to_string(root().join(".github/workflows/release.yml")).unwrap();
    let workflow: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();
    let publish = &workflow["jobs"]["publish"];

    assert_eq!(publish["permissions"]["actions"].as_str(), Some("read"));
    let publish_source = serde_yaml_ng::to_string(publish).unwrap();
    assert!(publish_source.contains("actions/workflows/ci.yml/runs?head_sha="));
    assert!(publish_source.contains("gh run download \"$CI_RUN_ID\""));
    assert!(publish_source.contains("release-candidate-$SOURCE_REVISION"));
    assert!(publish_source.contains("release-candidate-files.json.sha256"));
    assert!(publish_source.contains("startswith(\"flutter-release/\") | not"));
    assert!(publish_source.contains("Candidate-Inventory-SHA256: $INVENTORY_SHA256"));

    let flutter_source = serde_yaml_ng::to_string(&workflow["jobs"]["flutter"]).unwrap();
    assert!(flutter_source.contains("gh release download \"$GITHUB_REF_NAME\""));
    assert!(flutter_source.contains("release-candidate-files.json"));
    assert!(flutter_source.contains("startswith(\"flutter-release/\")"));
    assert!(flutter_source.contains("target/current-flutter-candidate-files.json"));

    let recovery_source = serde_yaml_ng::to_string(&workflow["jobs"]["recover-central"]).unwrap();
    assert!(recovery_source.contains("startswith(\"flutter-release/\") | not"));
    assert!(!recovery_source.contains("tools/flutter/package-release.sh"));
    assert!(
        !recovery_source
            .lines()
            .any(|line| line.trim() == "flutter pub publish")
    );
}

#[test]
fn apple_pod_bootstrap_is_protected_exact_and_publicly_verified() {
    let contents =
        fs::read_to_string(root().join(".github/workflows/publish-apple-pod.yml")).unwrap();
    let workflow: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();
    let publish = &workflow["jobs"]["publish"];

    assert_eq!(publish["environment"].as_str(), Some("release"));
    assert_eq!(publish["permissions"]["contents"].as_str(), Some("read"));
    assert!(contents.contains("COCOAPODS_TRUNK_TOKEN"));
    assert!(contents.contains("BotaDeviceSDKCore.xcframework.zip.sha256"));
    assert!(contents.contains("pod trunk push platforms/apple/BotaAppleSDK.podspec"));
    assert!(contents.contains("pod spec cat BotaAppleSDK --version"));
    assert!(!contents.contains("BOTA_APPLE_SDK_PACKAGE_PATH"));
}

#[test]
fn future_flutter_publication_uses_the_official_oidc_workflow_without_secrets() {
    let contents =
        fs::read_to_string(root().join(".github/workflows/publish-flutter.yml")).unwrap();
    let workflow: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();
    let gate = &workflow["jobs"]["gate"];
    let publish = &workflow["jobs"]["publish"];

    assert!(contents.contains("v[0-9]+.[0-9]+.[0-9]+-*"));
    assert!(contents.contains("tag-pattern on pub.dev: v{{version}}"));
    assert_eq!(gate["environment"].as_str(), Some("release"));
    assert_eq!(gate["permissions"]["actions"].as_str(), Some("read"));
    assert!(contents.contains("actions/workflows/release.yml/runs?head_sha="));
    assert!(contents.contains("flutter-release-$GITHUB_REF_NAME"));
    assert!(contents.contains("verify-publication.mjs verify-candidate"));
    assert!(contents.contains("verify-publication.mjs verify-public"));
    assert_eq!(publish["needs"].as_str(), Some("gate"));
    assert_eq!(
        publish["if"].as_str(),
        Some("needs.gate.outputs.needs-publish == 'true'")
    );
    assert_eq!(publish["permissions"]["id-token"].as_str(), Some("write"));
    assert_eq!(
        publish["uses"].as_str(),
        Some("dart-lang/setup-dart/.github/workflows/publish.yml@v1")
    );
    assert_eq!(
        publish["with"]["working-directory"].as_str(),
        Some("frameworks/flutter/bota_flutter_sdk")
    );
    assert!(!contents.contains("secrets:"));
    assert!(!contents.contains("PUB_TOKEN"));
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
    let build_command = android_commands
        .iter()
        .find(|command| command.contains("tools/android/test-publication-graphs.sh"))
        .unwrap();
    let gradle_invocations = build_command
        .split("platforms/android/gradlew -p platforms/android")
        .skip(1)
        .collect::<Vec<_>>();
    assert_eq!(gradle_invocations.len(), 2);
    assert!(gradle_invocations[0].contains(":sdk:assembleDebugAndroidTest"));
    assert!(!gradle_invocations[0].contains(":sdk:testDebugUnitTest"));
    assert!(gradle_invocations[1].starts_with(" :sdk:testDebugUnitTest"));
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
    assert!(contents.contains("cargo build -p xtask"));
    assert!(contents.contains("git archive \"$RELEASE_TAG\""));
    assert!(contents.contains("../debug/xtask release verify-tag \"$RELEASE_TAG\""));
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
    assert!(contents.contains("needs: [verify, apple, android, react-native, web]"));
    assert!(contents.contains("matrix:\n        api: [26, 35]"));
    assert!(contents.contains("tools/android/test-public-consumer.sh --api ${{ matrix.api }}"));
    assert!(!contents.contains("echo \"published=false\""));
}

#[test]
fn workflow_dispatch_inputs_are_never_interpolated_into_shell_source() {
    let contents = fs::read_to_string(root().join(".github/workflows/release.yml")).unwrap();
    let workflow: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();
    let jobs = workflow["jobs"].as_mapping().unwrap();

    for (job_name, job) in jobs {
        let Some(steps) = job["steps"].as_sequence() else {
            continue;
        };
        for step in steps {
            if let Some(command) = step["run"].as_str() {
                assert!(
                    !command.contains("${{ inputs."),
                    "job {job_name:?} interpolates workflow input into shell source: {command}"
                );
            }
        }
    }
}

#[test]
fn release_workflow_never_publishes_npm_without_the_beta_tag() {
    let contents = fs::read_to_string(root().join(".github/workflows/release.yml")).unwrap();
    let npm_publish_lines = contents
        .lines()
        .filter(|line| line.contains("npm@$NPM_CLI_VERSION") && line.contains(" publish "))
        .collect::<Vec<_>>();

    assert_eq!(npm_publish_lines.len(), 4);
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
