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
        val localRepository = providers.gradleProperty("botaAndroidSdkRepository").orNull
        if (localRepository != null) {
            maven { url = uri(localRepository) }
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "bota-flutter-sdk-android"
