buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.facebook.react:react-native-gradle-plugin")
    }
}

plugins {
    base
    id("com.android.application") version "8.13.2" apply false
    id("com.facebook.react.rootproject")
}

project(":adapter") {
    layout.buildDirectory.set(rootProject.layout.buildDirectory.dir("adapter"))
}
