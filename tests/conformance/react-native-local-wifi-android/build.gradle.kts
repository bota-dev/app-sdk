buildscript {
    repositories { google(); mavenCentral() }
    dependencies {
        classpath("com.facebook.react:react-native-gradle-plugin")
    }
}
plugins {
    base
    id("com.android.library") apply false
    id("com.android.application") apply false
    id("com.facebook.react.rootproject")
}
project(":transport") {
    layout.buildDirectory.set(rootProject.layout.buildDirectory.dir("transport"))
}
subprojects {
    configurations.configureEach {
        resolutionStrategy.eachDependency {
            if (requested.group == "com.facebook.react" && requested.name == "react-android") {
                useVersion("0.86.3")
            }
        }
    }
}
