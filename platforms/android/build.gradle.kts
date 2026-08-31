plugins {
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.dokka) apply false
    alias(libs.plugins.maven.publish) apply false
    alias(libs.plugins.binary.compatibility)
}

val versionFile = rootProject.layout.projectDirectory.file("../../sdk-version.toml").asFile
val canonicalSdkVersion = Regex("""(?m)^version\s*=\s*"([^"]+)"\s*$""")
    .find(versionFile.readText())
    ?.groupValues
    ?.get(1)
    ?: error("sdk-version.toml is missing its version authority")
val configuredSdkVersion = providers.gradleProperty("VERSION_NAME").get()

check(configuredSdkVersion == canonicalSdkVersion) {
    "VERSION_NAME $configuredSdkVersion does not match sdk-version.toml $canonicalSdkVersion"
}

allprojects {
    group = "dev.bota"
    version = canonicalSdkVersion
}
