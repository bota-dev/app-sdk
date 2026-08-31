import com.vanniktech.maven.publish.AndroidSingleVariantLibrary
import org.gradle.api.artifacts.dsl.LockMode
import org.gradle.api.tasks.Delete
import org.gradle.api.tasks.bundling.AbstractArchiveTask
import org.gradle.api.tasks.Exec
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
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets {
        getByName("main").jniLibs.srcDir(layout.buildDirectory.dir("generated/bota/jniLibs"))
    }

    buildTypes {
        getByName("debug") {
            externalNativeBuild {
                cmake {
                    arguments += "-DBOTA_ANDROID_JNI_TESTING=ON"
                }
            }
        }
        getByName("release") {
            externalNativeBuild {
                cmake {
                    arguments += "-DBOTA_ANDROID_JNI_TESTING=OFF"
                }
            }
        }
    }

    defaultConfig.externalNativeBuild.cmake {
        arguments += listOf(
            "-DBOTA_REPO_ROOT=${rootProject.projectDir.parentFile.parentFile.absolutePath}",
            "-DBOTA_RUST_LIB_DIR=${layout.buildDirectory.dir("generated/bota/jniLibs").get().asFile.absolutePath}",
        )
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
        disable += setOf("AndroidGradlePluginVersion", "GradleDependency", "NewerVersionAvailable")
        targetSdk = 36
        warningsAsErrors = true
    }

    testOptions {
        targetSdk = 36
    }

}

val generatedCompatibilitySource = layout.buildDirectory.dir("generated/source/botaCompatibility/kotlin")
val compatibilitySdkVersion = project.version.toString()
val generateCompatibilityVersion by tasks.registering {
    group = "build"
    description = "Generates the legacy BotaSdkVersion const from sdk-version.toml."
    inputs.property("sdkVersion", compatibilitySdkVersion)
    outputs.dir(generatedCompatibilitySource)
    doLast {
        val output = generatedCompatibilitySource.get().file("com/bota/sdk/BotaSdkVersion.kt").asFile
        output.parentFile.mkdirs()
        output.writeText(
            """package com.bota.sdk

@Deprecated("Use dev.bota.sdk.BotaAndroidSDK.version", ReplaceWith("BotaAndroidSDK.version", "dev.bota.sdk.BotaAndroidSDK"))
public object BotaSdkVersion {
    public const val current: String = "$compatibilitySdkVersion"
}
""",
        )
    }
}

val buildRustNative by tasks.registering(Exec::class) {
    group = "build"
    description = "Cross-compiles the frozen Rust ABI for all supported Android ABIs."
    val repositoryRoot = rootProject.projectDir.parentFile.parentFile
    commandLine(repositoryRoot.resolve("tools/android/build-native.sh"))
    inputs.files(
        fileTree(repositoryRoot) {
            include("Cargo.lock")
            include("Cargo.toml")
            include("rust-toolchain.toml")
            include("sdk-version.toml")
            include("core/device-sdk-core/Cargo.toml")
            include("core/device-sdk-core/src/**")
            include("bindings/device-sdk-ffi/Cargo.toml")
            include("bindings/device-sdk-ffi/include/bota_device_sdk.h")
            include("bindings/device-sdk-ffi/src/**")
            include("release/evidence/1.0.0-alpha.1-native-abi.md")
            include("tools/android/build-native.sh")
        },
    )
    outputs.dir(layout.buildDirectory.dir("generated/bota/jniLibs"))
}

val verifyProtocolFixtures by tasks.registering(Exec::class) {
    group = "verification"
    description = "Verifies that Android protocol fixture assets match the canonical suites."
    val repositoryRoot = rootProject.projectDir.parentFile.parentFile
    commandLine("node", repositoryRoot.resolve("tools/android/sync-protocol-fixtures.mjs"), "--check")
    inputs.dir(repositoryRoot.resolve("protocol/fixtures"))
    inputs.dir(file("src/androidTest/assets/ProtocolFixtures"))
}

val verifyWorkflowFixtures by tasks.registering(Exec::class) {
    group = "verification"
    description = "Verifies that Android workflow fixture assets match the canonical suites."
    val repositoryRoot = rootProject.projectDir.parentFile.parentFile
    commandLine("node", repositoryRoot.resolve("tools/android/sync-workflow-fixtures.mjs"), "--check")
    inputs.dir(repositoryRoot.resolve("protocol/workflows"))
    inputs.file(file("src/androidTest/assets/WorkflowFixtures/workflows.json"))
}

tasks.configureEach {
    if (name.startsWith("configureCMake") || name.endsWith("JniLibFolders")) {
        dependsOn(buildRustNative)
    }
    if (name == "preDebugAndroidTestBuild") {
        dependsOn(verifyProtocolFixtures)
        dependsOn(verifyWorkflowFixtures)
    }
}

kotlin {
    explicitApi()
    sourceSets.named("main") {
        kotlin.srcDir(generatedCompatibilitySource)
    }
    compilerOptions {
        allWarningsAsErrors.set(true)
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

tasks.matching { it.name.startsWith("compile") && it.name.endsWith("Kotlin") }.configureEach {
    dependsOn(generateCompatibilityVersion)
}
tasks.matching { it.name == "sourceReleaseJar" }.configureEach {
    dependsOn(generateCompatibilityVersion)
}

dependencies {
    api(libs.kotlinx.coroutines.android)
    api(libs.okhttp)

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

}

publishing {
    repositories {
        maven {
            name = "Local"
            url = rootProject.layout.projectDirectory.dir("../../target/android-m2").asFile.toURI()
        }
    }
}

val protectedSigning = when (val value = providers.gradleProperty("botaProtectedSigning").orNull) {
    null -> false
    "true" -> true
    else -> throw GradleException("botaProtectedSigning must be exactly true")
}

if (protectedSigning) {
    val signingKey = providers.gradleProperty("signingInMemoryKey").orNull
    val signingPassword = providers.gradleProperty("signingInMemoryKeyPassword").orNull
    if (signingKey.isNullOrBlank() || signingPassword.isNullOrBlank()) {
        throw GradleException("protected Android staging requires in-memory signing key and password")
    }

    mavenPublishing {
        signAllPublications()
    }
    publishing {
        repositories {
            maven {
                name = "CentralRaw"
                url = rootProject.layout.projectDirectory
                    .dir("../../target/android-central-raw").asFile.toURI()
            }
        }
    }

    val cleanCentralRawRepository = tasks.register<Delete>("cleanCentralRawRepository") {
        delete(rootProject.layout.projectDirectory.dir("../../target/android-central-raw"))
    }
    tasks.matching {
        it.name == "signMavenPublication" || it.name == "publishMavenPublicationToCentralRawRepository"
    }.configureEach {
        mustRunAfter(cleanCentralRawRepository)
        if (name == "publishMavenPublicationToCentralRawRepository") {
            dependsOn("signMavenPublication")
        }
    }
    tasks.register("stageSignedCentralRawRepository") {
        group = "publishing"
        description = "Stages the signed Maven publication in the isolated Central raw repository."
        dependsOn(cleanCentralRawRepository, "publishMavenPublicationToCentralRawRepository")
    }
} else {
    tasks.register("stageSignedCentralRawRepository") {
        group = "publishing"
        description = "Rejects protected staging when its exact opt-in property is absent."
        doFirst {
            throw GradleException("use -PbotaProtectedSigning=true in the protected release job")
        }
    }
}
