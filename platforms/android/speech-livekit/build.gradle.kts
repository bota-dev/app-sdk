import org.gradle.api.artifacts.dsl.LockMode
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "dev.bota.sdk.speech.livekit"
    compileSdk = 36
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint {
        warningsAsErrors = true
        disable += setOf("AndroidGradlePluginVersion", "GradleDependency", "NewerVersionAvailable")
    }
}
kotlin {
    explicitApi()
    compilerOptions {
        allWarningsAsErrors.set(true)
        jvmTarget.set(JvmTarget.JVM_17)
    }
}
dependencies {
    api(project(":sdk"))
    implementation(libs.livekit)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.json)
    testImplementation(libs.robolectric)
}
tasks.withType<Test>().configureEach {
    dependsOn(":sdk:buildHostJni")
    systemProperty("java.library.path", project(":sdk").layout.buildDirectory.dir("generated/bota/hostJni").get().asFile.absolutePath)
}
dependencyLocking {
    lockMode.set(LockMode.STRICT)
    lockAllConfigurations()
}
