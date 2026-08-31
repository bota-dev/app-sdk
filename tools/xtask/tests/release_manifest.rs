use std::{fs, path::PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn example() -> serde_json::Value {
    let contents = fs::read_to_string(root().join("release/examples/1.1.0.json")).unwrap();
    serde_json::from_str(&contents).unwrap()
}

fn validate_modified(
    name: &str,
    mutate: impl FnOnce(&mut serde_json::Value),
) -> Result<(), String> {
    let mut manifest = example();
    mutate(&mut manifest);
    let path = root()
        .join("release/examples")
        .join(format!(".test-{name}-{}.json", std::process::id()));
    fs::write(&path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
    let result = xtask::release::validate_manifest(&path);
    fs::remove_file(path).unwrap();
    result
}

#[test]
fn example_release_manifest_is_valid() {
    let manifest = root().join("release/examples/1.1.0.json");

    let result = xtask::release::validate_manifest(&manifest);

    assert!(result.is_ok(), "{result:?}");
}

#[test]
fn published_v1_manifest_remains_valid_independent_of_later_checkout_version() {
    let temp_root = std::env::temp_dir().join(format!(
        "bota-release-manifest-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&temp_root).unwrap();
    fs::write(temp_root.join("sdk-version.toml"), "version = \"1.1.0\"\n").unwrap();
    let manifest = temp_root.join("published-1.0.0-v1.json");
    fs::copy(
        root().join("release/examples/published-1.0.0-v1.json"),
        &manifest,
    )
    .unwrap();

    let historical_result = xtask::release::validate_manifest_format_and_semantics(&manifest);
    let current_release_result = xtask::release::validate_manifest(&manifest);
    fs::remove_dir_all(temp_root).unwrap();

    assert!(historical_result.is_ok(), "{historical_result:?}");
    assert!(
        current_release_result
            .unwrap_err()
            .contains("sdkVersion 1.0.0 does not match sdk-version.toml 1.1.0")
    );
}

#[test]
fn v2_manifest_requires_the_app_sdk_family() {
    let result = validate_modified("sdk-family", |manifest| {
        manifest.as_object_mut().unwrap().remove("sdkFamily");
    });
    assert!(result.unwrap_err().contains("sdkFamily"));
}

#[test]
fn v2_artifact_package_must_match_its_platform() {
    let result = validate_modified("package-identifier", |manifest| {
        manifest["artifacts"][0]["packageIdentifier"] = "BotaSDK".into();
    });
    assert!(result.unwrap_err().contains("packageIdentifier"));
}

#[test]
fn artifact_version_must_match_sdk_version() {
    let result = validate_modified("artifact-version", |manifest| {
        manifest["artifacts"][0]["version"] = "9.9.9".into();
    });

    assert!(result.unwrap_err().contains("artifact version"));
}

#[test]
fn source_revision_must_be_a_full_lowercase_sha() {
    let result = validate_modified("source-revision", |manifest| {
        manifest["sourceRevision"] = "ABC123".into();
    });

    assert!(result.unwrap_err().contains("sourceRevision"));
}

#[test]
fn firmware_range_must_be_ordered() {
    let result = validate_modified("firmware-range", |manifest| {
        manifest["firmwareCompatibility"]["minimum"] = "2.0.0".into();
        manifest["firmwareCompatibility"]["maximum"] = "1.0.0".into();
    });

    assert!(result.unwrap_err().contains("firmware compatibility"));
}

#[test]
fn checksums_must_be_lowercase_sha256() {
    let result = validate_modified("checksum", |manifest| {
        manifest["artifacts"][0]["checksumSha256"] = "A".repeat(64).into();
    });

    assert!(result.unwrap_err().contains("checksumSha256"));
}

#[test]
fn capabilities_must_be_unique() {
    let result = validate_modified("capabilities", |manifest| {
        manifest["artifacts"][0]["capabilities"] =
            serde_json::json!(["protocol_core", "protocol_core"]);
    });

    assert!(result.unwrap_err().contains("duplicate capability"));
}
