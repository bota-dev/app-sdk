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
        providers.gradleProperty("botaSdkRepository").orNull?.let { repository ->
            maven { url = uri(repository) }
        }
        mavenCentral()
    }
}

rootProject.name = "bota-android-legacy-consumer"
include(":app")
