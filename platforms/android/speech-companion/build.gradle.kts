import org.gradle.api.artifacts.dsl.LockMode
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "dev.bota.speech.companion"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.bota.speech.companion"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-source"
        ndk { abiFilters += setOf("arm64-v8a", "armeabi-v7a", "x86", "x86_64") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions { unitTests.isIncludeAndroidResources = true }
    lint {
        warningsAsErrors = true
        disable += setOf("AndroidGradlePluginVersion", "GradleDependency", "NewerVersionAvailable")
        // This internal consumer follows the SDK's fixed API 36 toolchain.
        // Keep newer-target advice visible without claiming that platform's qualification.
        informational += "OldTargetApi"
    }
}
kotlin { compilerOptions { allWarningsAsErrors.set(true); jvmTarget.set(JvmTarget.JVM_17) } }
dependencies {
    implementation(project(":speech-livekit"))
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.json)
    testImplementation(libs.robolectric)
    testImplementation(libs.mockwebserver)
}
tasks.withType<Test>().configureEach {
    dependsOn(":sdk:buildHostJni")
    systemProperty("java.library.path", project(":sdk").layout.buildDirectory.dir("generated/bota/hostJni").get().asFile.absolutePath)
}
dependencyLocking { lockMode.set(LockMode.STRICT); lockAllConfigurations() }
