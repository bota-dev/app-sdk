use std::{fs, path::PathBuf};

#[test]
fn crate_version_matches_workspace_sdk_version() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let manifest = fs::read_to_string(root.join("sdk-version.toml")).unwrap();
    let sdk_version = manifest
        .lines()
        .find_map(|line| line.strip_prefix("version = \"")?.strip_suffix('"'))
        .unwrap();

    assert_eq!(env!("CARGO_PKG_VERSION"), sdk_version);
}
