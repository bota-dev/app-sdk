import org.gradle.api.initialization.resolve.RepositoriesMode

pluginManagement {
    includeBuild("../../../frameworks/react-native/node_modules/@react-native/gradle-plugin")
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

includeBuild("../../../frameworks/react-native/node_modules/@react-native/gradle-plugin")

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        exclusiveContent {
            forRepository {
                maven {
                    url = uri(providers.gradleProperty("botaSdkRepository").get())
                }
            }
            filter { includeGroup("dev.bota") }
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "bota-react-native-android-adapter-consumer"
include(":app")
include(":adapter")
project(":adapter").projectDir = file("../../../frameworks/react-native/android")
