use std::{fs, path::PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn historical_example() -> serde_json::Value {
    let contents = fs::read_to_string(root().join("release/examples/1.2.0-beta.12.json")).unwrap();
    serde_json::from_str(&contents).unwrap()
}

const RENAMED_PACKAGES: &[(&str, &str)] = &[
    ("apple", "BotaAppSDK"),
    ("android", "dev.bota:bota-app-sdk"),
    ("react-native", "@bota.dev/react-native-app-sdk"),
    ("flutter", "bota_app_sdk"),
    ("web", "@bota.dev/web-app-sdk"),
];

fn validate_renamed(mutate: impl FnOnce(&mut serde_json::Value)) -> Result<(), String> {
    let mut manifest = historical_example();
    manifest["sdkVersion"] = "2.0.0-beta.0".into();
    for artifact in manifest["artifacts"].as_array_mut().unwrap() {
        artifact["version"] = "2.0.0-beta.0".into();
        artifact["packageIdentifier"] = RENAMED_PACKAGES
            .iter()
            .find(|(platform, _)| artifact["platform"] == *platform)
            .unwrap()
            .1
            .into();
    }
    mutate(&mut manifest);
    let directory = std::env::temp_dir().join(format!(
        "bota-renamed-manifest-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("manifest.json");
    fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let result = xtask::release::validate_manifest_format_and_semantics(&path);
    fs::remove_dir_all(directory).unwrap();
    result
}

#[test]
fn renamed_major_two_manifest_is_valid() {
    assert!(validate_renamed(|_| {}).is_ok());
}

#[test]
fn renamed_manifest_cannot_bypass_identity_checks() {
    assert!(validate_renamed(|manifest| manifest["manifestVersion"] = 1.into()).is_err());
    for historical in historical_example()["artifacts"].as_array().unwrap() {
        assert!(
            validate_renamed(|manifest| {
                let artifact = manifest["artifacts"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|artifact| artifact["platform"] == historical["platform"])
                    .unwrap();
                artifact["packageIdentifier"] = historical["packageIdentifier"].clone();
            })
            .is_err()
        );
    }
}

fn validate_modified(
    name: &str,
    mutate: impl FnOnce(&mut serde_json::Value),
) -> Result<(), String> {
    let contents = fs::read_to_string(root().join("release/examples/2.0.0-beta.2.json")).unwrap();
    let mut manifest = serde_json::from_str(&contents).unwrap();
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
    let manifest = root().join("release/examples/2.0.0-beta.2.json");

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
    fs::write(
        temp_root.join("sdk-version.toml"),
        "version = \"1.2.0-beta.12\"\n",
    )
    .unwrap();
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
            .contains("sdkVersion 1.0.0 does not match sdk-version.toml 1.2.0-beta.12")
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

#[test]
fn a_manifest_without_the_flutter_capability_does_not_require_flutter() {
    let manifest = root().join("release/examples/1.1.0.json");

    let result = xtask::release::validate_manifest_format_and_semantics(&manifest);

    assert!(result.is_ok(), "{result:?}");
}

#[test]
fn declaring_the_flutter_capability_requires_a_flutter_artifact() {
    let result = validate_modified("flutter-capability", |manifest| {
        manifest["artifacts"]
            .as_array_mut()
            .unwrap()
            .retain(|artifact| artifact["platform"] != "flutter");
        manifest["artifacts"][0]["capabilities"] =
            serde_json::json!(["apple_device_sdk", "flutter_sdk"]);
    });

    assert!(
        result
            .unwrap_err()
            .contains("flutter_sdk capability requires exactly one Flutter artifact")
    );
}

#[test]
fn flutter_artifact_binds_source_generator_normalized_checksum_and_inventory() {
    for (name, mutate, expected) in [
        (
            "flutter-source",
            Box::new(|artifact: &mut serde_json::Value| {
                artifact["sourceRevision"] = "b".repeat(40).into();
            }) as Box<dyn Fn(&mut serde_json::Value)>,
            "sourceRevision must match",
        ),
        (
            "flutter-generator",
            Box::new(|artifact: &mut serde_json::Value| {
                artifact["generator"]["version"] = "29.0.0".into();
            }),
            "generator",
        ),
        (
            "flutter-normalized-checksum",
            Box::new(|artifact: &mut serde_json::Value| {
                artifact["normalizedArchiveSha256"] = "0".repeat(64).into();
            }),
            "normalizedArchiveSha256",
        ),
        (
            "flutter-inventory",
            Box::new(|artifact: &mut serde_json::Value| {
                artifact["packageInventory"] = serde_json::json!([]);
            }),
            "packageInventory",
        ),
    ] {
        let result = validate_modified(name, |manifest| {
            let artifact = manifest["artifacts"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|artifact| artifact["platform"] == "flutter")
                .unwrap();
            mutate(artifact);
        });
        assert!(result.unwrap_err().contains(expected), "{name}");
    }
}

#[test]
fn flutter_package_inventory_must_be_sorted_unique_and_safe() {
    for (name, inventory, expected) in [
        (
            "flutter-inventory-sort",
            serde_json::json!([
                {"path": "pubspec.yaml", "byteLength": 1, "sha256": "a".repeat(64)},
                {"path": "LICENSE", "byteLength": 1, "sha256": "b".repeat(64)}
            ]),
            "sorted",
        ),
        (
            "flutter-inventory-duplicate",
            serde_json::json!([
                {"path": "pubspec.yaml", "byteLength": 1, "sha256": "a".repeat(64)},
                {"path": "pubspec.yaml", "byteLength": 1, "sha256": "b".repeat(64)}
            ]),
            "duplicate",
        ),
        (
            "flutter-inventory-traversal",
            serde_json::json!([
                {"path": "../pubspec.yaml", "byteLength": 1, "sha256": "a".repeat(64)}
            ]),
            "unsafe",
        ),
    ] {
        let result = validate_modified(name, |manifest| {
            let artifact = manifest["artifacts"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|artifact| artifact["platform"] == "flutter")
                .unwrap();
            artifact["packageInventory"] = inventory;
        });
        assert!(result.unwrap_err().contains(expected), "{name}");
    }
}
