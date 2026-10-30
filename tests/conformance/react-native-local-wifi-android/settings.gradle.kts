import org.gradle.api.initialization.resolve.RepositoriesMode

pluginManagement {
    resolutionStrategy {
        eachPlugin {
            if (requested.id.id.startsWith("com.android.")) useModule("com.android.tools.build:gradle:8.13.2")
        }
    }
    includeBuild("../../../frameworks/react-native/node_modules/@react-native/gradle-plugin")
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
includeBuild("../../../frameworks/react-native/node_modules/@react-native/gradle-plugin")
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "bota-local-wifi-native-consumer"
include(":transport")
include(":app")
project(":transport").projectDir = file("../../../frameworks/react-native/native-io/android")
