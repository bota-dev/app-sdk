use std::{ffi::OsString, path::PathBuf};

pub mod protocol;

pub mod release {
    use semver::Version;
    use serde::Deserialize;
    use sha2::{Digest, Sha256};
    use std::{collections::HashSet, fs, path::Path};

    const APP_SDK_PACKAGES: &[(&str, &str)] = &[
        ("apple", "BotaAppleSDK"),
        ("android", "dev.bota:bota-android-sdk"),
        ("react-native", "@bota.dev/react-native-sdk"),
        ("flutter", "bota_flutter_sdk"),
        ("web", "@bota.dev/web-sdk"),
        ("windows", "Bota.WindowsSdk"),
        ("electron", "@bota.dev/electron-sdk"),
    ];
    const ANDROID_GRADLE_DISTRIBUTION_URL: &str =
        "https\\://services.gradle.org/distributions/gradle-8.13-bin.zip";
    const ANDROID_GRADLE_DISTRIBUTION_SHA256: &str =
        "20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78";
    const ANDROID_GRADLE_WRAPPER_SHA256: &str =
        "81a82aaea5abcc8ff68b3dfcb58b3c3c429378efd98e7433460610fecd7ae45f";

    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct ReleaseInfo {
        pub version: String,
        pub crate_name: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ReleaseManifest {
        manifest_version: u32,
        sdk_family: Option<String>,
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
        platform: Option<String>,
        package_identifier: Option<String>,
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

    #[derive(Deserialize)]
    struct AndroidVersionCatalog {
        versions: AndroidVersions,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AndroidVersions {
        agp: String,
        maven_publish: String,
    }

    #[derive(Deserialize)]
    struct PackageJson {
        version: String,
        private: bool,
    }

    #[derive(Deserialize)]
    struct CargoManifest {
        package: CargoPackage,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "kebab-case")]
    struct CargoPackage {
        name: String,
        version: String,
        rust_version: Option<String>,
        description: Option<String>,
        license: Option<String>,
        repository: Option<String>,
        documentation: Option<String>,
        readme: Option<String>,
        keywords: Option<Vec<String>>,
        categories: Option<Vec<String>>,
        publish: Option<toml::Value>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CompatibilityMatrix {
        sdk_version: String,
    }

    pub fn verify_release(root: &Path, tag: &str) -> Result<ReleaseInfo, String> {
        let tag_version = tag
            .strip_prefix('v')
            .ok_or_else(|| "release tag must start with v".to_owned())?;
        parse_version("release tag", tag_version)?;

        let expected: SdkVersion = parse_toml_file(&root.join("sdk-version.toml"))?;
        if tag_version != expected.version {
            return Err(format!(
                "release tag {tag} does not match sdk-version.toml {}",
                expected.version
            ));
        }

        let package_json: PackageJson = parse_json_file(&root.join("package.json"))?;
        if !package_json.private {
            return Err("workspace package.json must remain private".to_owned());
        }
        require_version("package.json", &package_json.version, &expected.version)?;

        let core_path = root.join("core/device-sdk-core/Cargo.toml");
        let core: CargoManifest = parse_toml_file(&core_path)?;
        require_version(
            "bota-device-sdk-core",
            &core.package.version,
            &expected.version,
        )?;
        validate_publishable_crate(&core_path, &core.package)?;

        let xtask: CargoManifest = parse_toml_file(&root.join("tools/xtask/Cargo.toml"))?;
        require_version("xtask", &xtask.package.version, &expected.version)?;

        let compatibility: CompatibilityMatrix =
            parse_json_file(&root.join("protocol/compatibility/firmware-compatibility.json"))?;
        require_version(
            "compatibility matrix",
            &compatibility.sdk_version,
            &expected.version,
        )?;

        let manifest_path = root
            .join("release/examples")
            .join(format!("{}.json", expected.version));
        validate_manifest(&manifest_path)?;

        Ok(ReleaseInfo {
            version: expected.version,
            crate_name: core.package.name,
        })
    }

    pub fn verify_android_build(root: &Path) -> Result<(), String> {
        let expected: SdkVersion = parse_toml_file(&root.join("sdk-version.toml"))?;
        let gradle_properties =
            fs::read_to_string(root.join("platforms/android/gradle.properties"))
                .map_err(|error| format!("cannot read Android gradle.properties: {error}"))?;
        let android_version = gradle_properties
            .lines()
            .find_map(|line| line.strip_prefix("VERSION_NAME="))
            .ok_or_else(|| "Android gradle.properties is missing VERSION_NAME".to_owned())?;
        require_version("Android Gradle project", android_version, &expected.version)?;

        let wrapper = fs::read_to_string(
            root.join("platforms/android/gradle/wrapper/gradle-wrapper.properties"),
        )
        .map_err(|error| format!("cannot read Android Gradle wrapper properties: {error}"))?;
        let distribution_url = unique_gradle_property(&wrapper, "distributionUrl")?;
        if distribution_url != ANDROID_GRADLE_DISTRIBUTION_URL {
            return Err("Android Gradle wrapper must use the official Gradle 8.13 URL".to_owned());
        }
        let distribution_sha256 = unique_gradle_property(&wrapper, "distributionSha256Sum")?;
        if distribution_sha256 != ANDROID_GRADLE_DISTRIBUTION_SHA256 {
            return Err("Android Gradle wrapper checksum must match Gradle 8.13".to_owned());
        }
        let wrapper_jar =
            fs::read(root.join("platforms/android/gradle/wrapper/gradle-wrapper.jar"))
                .map_err(|error| format!("cannot read Android Gradle wrapper JAR: {error}"))?;
        let wrapper_jar_sha256 = Sha256::digest(wrapper_jar)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if wrapper_jar_sha256 != ANDROID_GRADLE_WRAPPER_SHA256 {
            return Err("Android Gradle wrapper JAR checksum must match Gradle 8.13".to_owned());
        }

        let catalog: AndroidVersionCatalog =
            parse_toml_file(&root.join("platforms/android/gradle/libs.versions.toml"))?;
        if catalog.versions.agp != "8.13.2" {
            return Err(format!(
                "Android Gradle Plugin must be 8.13.2, found {}",
                catalog.versions.agp
            ));
        }
        if catalog.versions.maven_publish != "0.35.0" {
            return Err(format!(
                "Gradle Maven Publish Plugin must remain 0.35.0 with Gradle 8, found {}",
                catalog.versions.maven_publish
            ));
        }

        let android_build = fs::read_to_string(root.join("platforms/android/build.gradle.kts"))
            .map_err(|error| format!("cannot read Android root build: {error}"))?;
        if !android_build.contains("check(configuredSdkVersion == canonicalSdkVersion)") {
            return Err("Android build must reject VERSION_NAME overrides".to_owned());
        }

        let sdk_build = fs::read_to_string(root.join("platforms/android/sdk/build.gradle.kts"))
            .map_err(|error| format!("cannot read Android SDK build: {error}"))?;
        if sdk_build.matches("targetSdk = 36").count() != 2
            || !sdk_build.contains("lockMode.set(LockMode.STRICT)")
        {
            return Err(
                "Android SDK must use API 36 for lint/tests and strict dependency locks".to_owned(),
            );
        }

        let manifest =
            fs::read_to_string(root.join("platforms/android/sdk/src/main/AndroidManifest.xml"))
                .map_err(|error| format!("cannot read Android SDK manifest: {error}"))?;
        if !manifest.contains(
            "android:name=\"android.permission.ACCESS_FINE_LOCATION\"\n        android:maxSdkVersion=\"30\"",
        ) {
            return Err(
                "Android SDK must declare location for BLE scans through API 30".to_owned(),
            );
        }

        let lock = fs::read_to_string(root.join("platforms/android/sdk/gradle.lockfile"))
            .map_err(|error| format!("cannot read Android SDK dependency lock: {error}"))?;
        for dependency in [
            "androidx.test:core:1.7.0",
            "androidx.test:runner:1.7.0",
            "androidx.test.ext:junit:1.3.0",
        ] {
            if !lock.contains(dependency) {
                return Err(format!(
                    "Android SDK dependency lock is missing {dependency}"
                ));
            }
        }

        Ok(())
    }

    fn unique_gradle_property<'a>(contents: &'a str, key: &str) -> Result<&'a str, String> {
        let prefix = format!("{key}=");
        let mut values = Vec::new();
        for line in contents.lines() {
            let trimmed = line.trim_start();
            if trimmed.is_empty() || trimmed.starts_with(['#', '!']) {
                continue;
            }
            if has_java_properties_continuation(trimmed) {
                return Err(
                    "Android Gradle wrapper properties must not use continuations".to_owned(),
                );
            }
            if java_properties_key(trimmed) != key {
                continue;
            }
            let value = line.strip_prefix(&prefix).ok_or_else(|| {
                format!("Android Gradle wrapper property {key} must use canonical key=value syntax")
            })?;
            values.push(value);
        }
        let mut values = values.into_iter();
        let value = values
            .next()
            .ok_or_else(|| format!("Android Gradle wrapper is missing {key}"))?;
        if values.next().is_some() {
            return Err(format!(
                "Android Gradle wrapper property {key} must not be repeated"
            ));
        }
        Ok(value)
    }

    fn java_properties_key(line: &str) -> String {
        let mut key = String::new();
        let mut escaped = false;
        for character in line.chars() {
            if escaped {
                key.push(character);
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '=' || character == ':' || character.is_whitespace() {
                break;
            } else {
                key.push(character);
            }
        }
        key
    }

    fn has_java_properties_continuation(line: &str) -> bool {
        line.chars()
            .rev()
            .take_while(|character| *character == '\\')
            .count()
            % 2
            == 1
    }

    pub fn validate_manifest(path: &Path) -> Result<(), String> {
        let manifest = read_release_manifest(path)?;
        let root = repository_root(path)?;
        let sdk_version_file = fs::read_to_string(root.join("sdk-version.toml"))
            .map_err(|error| format!("cannot read sdk-version.toml: {error}"))?;
        let expected: SdkVersion = toml::from_str(&sdk_version_file)
            .map_err(|error| format!("invalid sdk-version.toml: {error}"))?;

        validate_release_manifest(&manifest, Some(&expected.version))
    }

    pub fn validate_manifest_format_and_semantics(path: &Path) -> Result<(), String> {
        let manifest = read_release_manifest(path)?;
        validate_release_manifest(&manifest, None)
    }

    fn read_release_manifest(path: &Path) -> Result<ReleaseManifest, String> {
        let contents = fs::read_to_string(path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        serde_json::from_str(&contents)
            .map_err(|error| format!("invalid release manifest JSON: {error}"))
    }

    fn validate_release_manifest(
        manifest: &ReleaseManifest,
        expected_sdk_version: Option<&str>,
    ) -> Result<(), String> {
        match manifest.manifest_version {
            1 => {}
            2 => {
                if manifest.sdk_family.as_deref() != Some("bota-app-sdk") {
                    return Err("sdkFamily must be bota-app-sdk for manifestVersion 2".to_owned());
                }
            }
            _ => return Err("manifestVersion must be 1 or 2".to_owned()),
        }
        parse_version("sdkVersion", &manifest.sdk_version)?;
        if let Some(expected_sdk_version) = expected_sdk_version
            && manifest.sdk_version != expected_sdk_version
        {
            return Err(format!(
                "sdkVersion {} does not match sdk-version.toml {expected_sdk_version}",
                manifest.sdk_version
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
            if manifest.manifest_version == 2 {
                let platform = artifact
                    .platform
                    .as_deref()
                    .ok_or_else(|| format!("artifact {} is missing platform", artifact.name))?;
                let package_identifier =
                    artifact.package_identifier.as_deref().ok_or_else(|| {
                        format!("artifact {} is missing packageIdentifier", artifact.name)
                    })?;
                if !APP_SDK_PACKAGES.contains(&(platform, package_identifier)) {
                    return Err(format!(
                        "artifact packageIdentifier {package_identifier} does not match platform {platform}"
                    ));
                }
            }
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

    fn require_version(field: &str, actual: &str, expected: &str) -> Result<(), String> {
        if actual != expected {
            return Err(format!(
                "{field} version {actual} does not match SDK version {expected}"
            ));
        }
        Ok(())
    }

    fn validate_publishable_crate(path: &Path, package: &CargoPackage) -> Result<(), String> {
        if matches!(package.publish, Some(toml::Value::Boolean(false))) {
            return Err(format!("{} is marked publish = false", package.name));
        }
        for (field, value) in [
            ("description", package.description.as_deref()),
            ("license", package.license.as_deref()),
            ("repository", package.repository.as_deref()),
            ("documentation", package.documentation.as_deref()),
            ("rust-version", package.rust_version.as_deref()),
        ] {
            if value.is_none_or(str::is_empty) {
                return Err(format!("{} is missing package.{field}", package.name));
            }
        }
        if package.keywords.as_ref().is_none_or(Vec::is_empty) {
            return Err(format!("{} is missing package.keywords", package.name));
        }
        if package.categories.as_ref().is_none_or(Vec::is_empty) {
            return Err(format!("{} is missing package.categories", package.name));
        }
        let readme = package
            .readme
            .as_deref()
            .ok_or_else(|| format!("{} is missing package.readme", package.name))?;
        let readme_path = path
            .parent()
            .ok_or_else(|| format!("cannot resolve parent of {}", path.display()))?
            .join(readme);
        if !readme_path.is_file() {
            return Err(format!(
                "package readme does not exist: {}",
                readme_path.display()
            ));
        }
        Ok(())
    }

    fn parse_toml_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
        let contents = fs::read_to_string(path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        toml::from_str(&contents).map_err(|error| format!("invalid {}: {error}", path.display()))
    }

    fn parse_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
        let contents = fs::read_to_string(path)
            .map_err(|error| format!("cannot read {}: {error}", path.display()))?;
        serde_json::from_str(&contents)
            .map_err(|error| format!("invalid {}: {error}", path.display()))
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
        [release, verify_tag, tag]
            if release == "release" && verify_tag == "verify-tag" =>
        {
            let root = std::env::current_dir()
                .map_err(|error| format!("cannot resolve repository root: {error}"))?;
            let info = release::verify_release(&root, &tag.to_string_lossy())?;
            println!(
                "release tag is valid: v{} ({})",
                info.version, info.crate_name
            );
            Ok(())
        }
        _ => Err(
            "usage: cargo xtask <protocol generate [--check] | release validate <manifest.json> | release verify-tag <vVERSION>>".to_owned(),
        ),
    }
}
