use std::{fs, path::PathBuf};

#[test]
fn client_identity_is_generated_from_the_release_authority() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    xtask::release::generate_client_identity(&root, true).unwrap();
    let package: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(root.join("frameworks/web/package.json")).unwrap(),
    )
    .unwrap();
    let source = fs::read_to_string(root.join("frameworks/web/src/sdkIdentity.ts")).unwrap();
    assert!(source.contains(package["name"].as_str().unwrap()));
    assert!(source.contains(package["version"].as_str().unwrap()));
}
