plugins {
    id("com.android.application")
}
android {
    namespace = "dev.bota.localwifi.consumer"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.bota.localwifi.consumer"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies {
    implementation(project(":transport"))
    implementation("com.facebook.react:react-android")
}
