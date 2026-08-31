plugins {
    id("com.android.application")
    id("com.facebook.react")
}

react {
    root.set(file("../../../../frameworks/react-native"))
    reactNativeDir.set(file("../../../../frameworks/react-native/node_modules/react-native"))
    codegenDir.set(file("../../../../frameworks/react-native/node_modules/@react-native/codegen"))
    debuggableVariants.set(listOf("debug", "release"))
}

android {
    namespace = "dev.bota.sdk.reactnative.consumer"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.bota.sdk.reactnative.consumer"
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
    implementation(project(":adapter"))
    implementation("com.facebook.react:react-android")
}
