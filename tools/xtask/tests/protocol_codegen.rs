use std::{fs, path::PathBuf};

#[test]
fn generated_protocol_constants_are_current() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let checked_in =
        fs::read_to_string(root.join("core/device-sdk-core/src/generated/protocol.rs"))
            .unwrap_or_default();

    let generated = xtask::protocol::generated_content(&root);

    assert_eq!(generated.as_deref(), Ok(checked_in.as_str()));
}
