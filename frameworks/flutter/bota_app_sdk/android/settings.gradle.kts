pluginManagement {
    plugins {
        id("com.android.library") version "8.13.2"
        id("org.jetbrains.kotlin.android") version "2.1.20"
    }
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        val localRepository = providers.gradleProperty("botaAndroidSdkRepository").orNull
        if (localRepository != null) {
            maven { url = uri(localRepository) }
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "bota-flutter-sdk-android"
