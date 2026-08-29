use std::{fs, path::PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn version_tag_and_publishable_metadata_are_synchronized() {
    let release = xtask::release::verify_release(&root(), "v1.0.0").unwrap();

    assert_eq!(release.version, "1.0.0");
    assert_eq!(release.crate_name, "bota-device-sdk-core");
}

#[test]
fn mismatched_or_unprefixed_tags_are_rejected() {
    let wrong_version = xtask::release::verify_release(&root(), "v2.0.0").unwrap_err();
    let missing_prefix = xtask::release::verify_release(&root(), "1.0.0").unwrap_err();

    assert!(wrong_version.contains("does not match"));
    assert!(missing_prefix.contains("must start with v"));
}

#[test]
fn release_workflow_is_tag_only_protected_and_dry_runs_before_publish() {
    let path = root().join(".github/workflows/release.yml");
    let contents = fs::read_to_string(path).unwrap();
    let _: serde_yaml_ng::Value = serde_yaml_ng::from_str(&contents).unwrap();

    assert!(contents.contains("tags:"));
    assert!(!contents.contains("workflow_dispatch"));
    assert!(contents.contains("contents: write"));
    assert!(contents.contains("environment: release"));
    assert!(contents.contains("fetch-depth: 0"));
    assert!(contents.contains("git merge-base --is-ancestor"));
    assert!(contents.contains("release verify-tag"));
    assert!(contents.contains("cargo deny check"));
    assert!(contents.contains("cargo publish --locked --package \"$CRATE_NAME\" --dry-run"));
    assert_eq!(contents.matches("secrets.CRATES_IO_TOKEN").count(), 1);
}
