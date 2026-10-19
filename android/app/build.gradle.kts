plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Your release key stays outside the repository (~/.gradle/gradle.properties); without one the debug key signs the build.
val releaseStoreFile: String? = providers.gradleProperty("CHOIDEV_RELEASE_STORE_FILE").orNull

// Your PC's ChoiTerm address built in (-Pchoiterm.home=https://pc.tailnet.ts.net:8449/, or in
// ~/.gradle/gradle.properties); without it the app asks on its first start.
val choitermHome: String = providers.gradleProperty("choiterm.home").orNull ?: ""

android {
    namespace = "com.choidev.choiterm"
    compileSdk = 36

    buildFeatures { buildConfig = true }

    defaultConfig {
        applicationId = "com.choidev.choiterm"
        minSdk = 31
        targetSdk = 36
        versionCode = 12
        versionName = "0.9.0"
        buildConfigField("String", "CHOITERM_HOME", "\"$choitermHome\"")
    }

    signingConfigs {
        create("release") {
            if (releaseStoreFile != null) {
                storeFile = file(releaseStoreFile)
                storePassword = providers.gradleProperty("CHOIDEV_RELEASE_STORE_PASSWORD").orNull
                keyAlias = providers.gradleProperty("CHOIDEV_RELEASE_KEY_ALIAS").orNull
                keyPassword = providers.gradleProperty("CHOIDEV_RELEASE_KEY_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Without your own key the debug key signs it, so the APK still installs.
            signingConfig = signingConfigs.getByName(if (releaseStoreFile != null) "release" else "debug")
        }
    }

    androidResources { localeFilters += listOf("ko") }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
    // The real org.json, since android.jar only has stubs in JVM unit tests.
    testImplementation("org.json:json:20240303")
}
