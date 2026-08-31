import com.vanniktech.maven.publish.AndroidSingleVariantLibrary
import org.gradle.api.artifacts.dsl.LockMode
import org.gradle.api.tasks.bundling.AbstractArchiveTask
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.dokka)
    alias(libs.plugins.maven.publish)
}

android {
    namespace = "dev.bota.sdk"
    compileSdk = 36
    ndkVersion = "28.2.13676358"

    defaultConfig {
        minSdk = 26
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
        buildConfigField("String", "BOTA_SDK_VERSION", "\"${project.version}\"")

        ndk {
            abiFilters += setOf("arm64-v8a", "armeabi-v7a", "x86_64", "x86")
        }
    }

    externalNativeBuild {
        cmake {
            version = "3.22.1"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
        disable += setOf("AndroidGradlePluginVersion", "NewerVersionAvailable")
        targetSdk = 36
        warningsAsErrors = true
    }

    testOptions {
        targetSdk = 36
    }

}

kotlin {
    explicitApi()
    compilerOptions {
        allWarningsAsErrors.set(true)
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.mockwebserver)

    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.runner)
}

dependencyLocking {
    lockMode.set(LockMode.STRICT)
    lockAllConfigurations()
}

tasks.withType<AbstractArchiveTask>().configureEach {
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}

tasks.withType<Test>().configureEach {
    systemProperty("bota.test.sdkVersion", project.version.toString())
}

mavenPublishing {
    configure(
        AndroidSingleVariantLibrary(
            variant = "release",
            sourcesJar = true,
            publishJavadocJar = true,
        ),
    )
    coordinates(
        groupId = "dev.bota",
        artifactId = "bota-android-sdk",
        version = project.version.toString(),
    )
    publishToMavenCentral()

    pom {
        name.set("Bota SDK for Android")
        description.set("Android facade for connecting applications to Bota devices.")
        inceptionYear.set("2026")
        url.set("https://github.com/bota-dev/app-sdk")
        licenses {
            license {
                name.set("MIT License")
                url.set("https://opensource.org/license/mit")
                distribution.set("repo")
            }
        }
        developers {
            developer {
                id.set("bota-dev")
                name.set("Bota")
                url.set("https://bota.dev")
            }
        }
        scm {
            url.set("https://github.com/bota-dev/app-sdk")
            connection.set("scm:git:git://github.com/bota-dev/app-sdk.git")
            developerConnection.set("scm:git:ssh://git@github.com/bota-dev/app-sdk.git")
        }
    }

    if (providers.gradleProperty("botaProtectedSigning").orNull == "true") {
        signAllPublications()
    }
}

publishing {
    repositories {
        maven {
            name = "Local"
            url = rootProject.layout.projectDirectory.dir("../../target/android-m2").asFile.toURI()
        }
    }
}

tasks.register("stageSignedCentralRawRepository") {
    group = "publishing"
    description = "Guard for the protected signed Central raw-repository graph."
    doFirst {
        check(providers.gradleProperty("botaProtectedSigning").orNull == "true") {
            "stageSignedCentralRawRepository requires -PbotaProtectedSigning=true"
        }
    }
}
