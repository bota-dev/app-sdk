plugins {
    id("com.android.library") version "8.13.2"
    id("org.jetbrains.kotlin.android") version "2.1.20"
}

fun requiredSdkVersion(): String {
    val versionFile = rootDir.resolve("../../../../sdk-version.toml").canonicalFile
    val match = Regex("(?m)^version\\s*=\\s*\"([^\"]+)\"\\s*$").find(versionFile.readText())
        ?: error("sdk-version.toml does not contain version")
    return match.groupValues[1]
}

val sdkVersion = requiredSdkVersion()
val overrideVersion = providers.gradleProperty("botaAndroidSdkVersion").orNull
require(overrideVersion == null || overrideVersion == sdkVersion) {
    "botaAndroidSdkVersion must match sdk-version.toml ($sdkVersion)"
}

val flutterSdkPath = providers.gradleProperty("flutterSdkPath").orNull
    ?: System.getenv("BOTA_FLUTTER_HOME")
    ?: error("flutterSdkPath or BOTA_FLUTTER_HOME is required")
val flutterJar = file("$flutterSdkPath/bin/cache/artifacts/engine/android-arm64/flutter.jar")
require(flutterJar.isFile) { "Flutter embedding JAR is missing: $flutterJar" }

android {
    namespace = "dev.bota.sdk.flutter"
    compileSdk = 36

    defaultConfig {
        minSdk = 26
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
        allWarningsAsErrors = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
        warningsAsErrors = true
        disable += "NewerVersionAvailable"
    }
}

dependencies {
    compileOnly(files(flutterJar))
    implementation("dev.bota:bota-android-sdk:$sdkVersion")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    testImplementation(files(flutterJar))
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}
