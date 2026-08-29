use std::{ffi::OsString, path::PathBuf};

pub mod protocol;

pub mod release {
    use semver::Version;
    use serde::Deserialize;
    use std::{collections::HashSet, fs, path::Path};

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ReleaseManifest {
        manifest_version: u32,
        sdk_version: String,
        source_revision: String,
        protocol_fixture_digest: String,
        firmware_compatibility: FirmwareCompatibility,
        artifacts: Vec<Artifact>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct FirmwareCompatibility {
        minimum: String,
        maximum: String,
        baseline_revision: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Artifact {
        name: String,
        ecosystem: String,
        version: String,
        checksum_sha256: String,
        capabilities: Vec<String>,
    }

    #[derive(Deserialize)]
    struct SdkVersion {
        version: String,
    }

    pub fn validate_manifest(path: &Path) -> Result<(), String> {
        let contents = fs::read_to_string(path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        let manifest: ReleaseManifest = serde_json::from_str(&contents)
            .map_err(|error| format!("invalid release manifest JSON: {error}"))?;
        let root = repository_root(path)?;
        let sdk_version_file = fs::read_to_string(root.join("sdk-version.toml"))
            .map_err(|error| format!("cannot read sdk-version.toml: {error}"))?;
        let expected: SdkVersion = toml::from_str(&sdk_version_file)
            .map_err(|error| format!("invalid sdk-version.toml: {error}"))?;

        if manifest.manifest_version != 1 {
            return Err("manifestVersion must be 1".to_owned());
        }
        parse_version("sdkVersion", &manifest.sdk_version)?;
        if manifest.sdk_version != expected.version {
            return Err(format!(
                "sdkVersion {} does not match sdk-version.toml {}",
                manifest.sdk_version, expected.version
            ));
        }
        require_lower_hex("sourceRevision", &manifest.source_revision, 40)?;
        require_lower_hex(
            "protocolFixtureDigest",
            &manifest.protocol_fixture_digest,
            64,
        )?;

        let minimum = parse_version(
            "firmwareCompatibility.minimum",
            &manifest.firmware_compatibility.minimum,
        )?;
        let maximum = parse_version(
            "firmwareCompatibility.maximum",
            &manifest.firmware_compatibility.maximum,
        )?;
        if minimum > maximum {
            return Err("firmware compatibility minimum exceeds maximum".to_owned());
        }
        require_lower_hex(
            "firmwareCompatibility.baselineRevision",
            &manifest.firmware_compatibility.baseline_revision,
            40,
        )?;

        if manifest.artifacts.is_empty() {
            return Err("artifacts must not be empty".to_owned());
        }
        for artifact in &manifest.artifacts {
            if artifact.name.is_empty() || artifact.ecosystem.is_empty() {
                return Err("artifact name and ecosystem must not be empty".to_owned());
            }
            parse_version("artifact version", &artifact.version)?;
            if artifact.version != manifest.sdk_version {
                return Err(format!(
                    "artifact version {} for {} does not match sdkVersion {}",
                    artifact.version, artifact.name, manifest.sdk_version
                ));
            }
            require_lower_hex("checksumSha256", &artifact.checksum_sha256, 64)?;
            let mut capabilities = HashSet::new();
            for capability in &artifact.capabilities {
                if capability.is_empty() {
                    return Err(format!(
                        "artifact {} contains an empty capability",
                        artifact.name
                    ));
                }
                if !capabilities.insert(capability) {
                    return Err(format!(
                        "artifact {} contains duplicate capability {capability}",
                        artifact.name
                    ));
                }
            }
        }

        Ok(())
    }

    fn repository_root(path: &Path) -> Result<&Path, String> {
        path.ancestors()
            .find(|ancestor| ancestor.join("sdk-version.toml").is_file())
            .ok_or_else(|| "cannot locate sdk-version.toml from manifest path".to_owned())
    }

    fn parse_version(field: &str, value: &str) -> Result<Version, String> {
        Version::parse(value).map_err(|error| format!("{field} is not semantic version: {error}"))
    }

    fn require_lower_hex(field: &str, value: &str, length: usize) -> Result<(), String> {
        if value.len() != length
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(format!(
                "{field} must be exactly {length} lowercase hexadecimal characters"
            ));
        }
        Ok(())
    }
}

pub fn run(args: impl IntoIterator<Item = OsString>) -> Result<(), String> {
    let args: Vec<OsString> = args.into_iter().collect();
    match args.as_slice() {
        [protocol, generate] if protocol == "protocol" && generate == "generate" => {
            let root = std::env::current_dir()
                .map_err(|error| format!("cannot resolve repository root: {error}"))?;
            let changed = protocol::generate(&root, false)?;
            println!(
                "protocol constants {}",
                if changed {
                    "generated"
                } else {
                    "already current"
                }
            );
            Ok(())
        }
        [protocol, generate, check]
            if protocol == "protocol" && generate == "generate" && check == "--check" =>
        {
            let root = std::env::current_dir()
                .map_err(|error| format!("cannot resolve repository root: {error}"))?;
            protocol::generate(&root, true)?;
            println!("protocol constants are current");
            Ok(())
        }
        [release, validate, path] if release == "release" && validate == "validate" => {
            let path = PathBuf::from(path);
            release::validate_manifest(&path)?;
            println!("release manifest is valid: {}", path.display());
            Ok(())
        }
        _ => Err(
            "usage: cargo xtask <protocol generate [--check] | release validate <manifest.json>>"
                .to_owned(),
        ),
    }
}
