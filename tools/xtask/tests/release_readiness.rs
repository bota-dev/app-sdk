use std::{fs, path::PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
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
