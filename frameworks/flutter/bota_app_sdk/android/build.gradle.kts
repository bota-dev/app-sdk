import com.android.build.api.dsl.LibraryExtension
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

fun requiredSdkVersion(): String {
    val versionFile = projectDir.resolve("sdk-version.toml").canonicalFile
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
    ?: rootProject.file("local.properties").takeIf { it.isFile }?.let { file ->
        Properties().apply { file.inputStream().use { load(it) } }.getProperty("flutter.sdk")
    }
    ?: System.getenv("FLUTTER_ROOT")
    ?: error("Flutter SDK not found: set flutter.sdk in the application's local.properties")
val flutterJar = file("$flutterSdkPath/bin/cache/artifacts/engine/android-arm64/flutter.jar")
require(flutterJar.isFile) { "Flutter embedding JAR is missing: $flutterJar" }

extensions.configure<LibraryExtension> {
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

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
        allWarningsAsErrors = true
    }
}

dependencies {
    compileOnly(files(flutterJar))
    implementation("dev.bota:bota-app-sdk:$sdkVersion")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    testImplementation(files(flutterJar))
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}
