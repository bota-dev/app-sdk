import com.vanniktech.maven.publish.AndroidSingleVariantLibrary
import org.gradle.api.artifacts.dsl.LockMode
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
        disable += setOf("AndroidGradlePluginVersion", "NewerVersionAvailable")
        targetSdk = 36
        warningsAsErrors = true
    }

    testOptions {
        targetSdk = 36
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

tasks.configureEach {
    if (name.startsWith("configureCMake") || name.endsWith("JniLibFolders")) {
        dependsOn(buildRustNative)
    }
    if (name == "preDebugAndroidTestBuild") {
        dependsOn(verifyProtocolFixtures)
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
