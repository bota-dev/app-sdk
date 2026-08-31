plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.bota.legacy"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.bota.legacy"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

val mode = providers.gradleProperty("botaLegacyMode").orElse("source")
val sdkVersion = providers.gradleProperty("botaSdkVersion")

dependencies {
    if (mode.get() == "binary") {
        compileOnly(files(providers.gradleProperty("botaLegacyAar").get()))
        runtimeOnly("dev.bota:bota-android-sdk:${sdkVersion.get()}")
    } else {
        implementation("dev.bota:bota-android-sdk:${sdkVersion.get()}")
    }
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
