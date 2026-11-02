pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        exclusiveContent {
            forRepository { maven("https://jitpack.io") }
            filter { includeVersion("com.github.davidliu", "audioswitch", "039a35aefab7747c557242fa216c9ea11743b604") }
        }
    }
}

rootProject.name = "bota-app-sdk-android"

include(":sdk")
include(":speech-livekit")
