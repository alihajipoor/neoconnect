plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.neoxify.vpn"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    sourceSets["main"].jniLibs.srcDir("libs/jni")
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    // For ActivityResult, which the VPN consent dialog comes back through.
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")

    // WireGuard's own embeddable tunnel library -- Apache-2.0, published
    // by the WireGuard project separately from their GPLv2 Android app
    // precisely so it can be used in apps like this one. It bundles the
    // same wireguard-go this product already runs server-side.
    //
    // Bundling the real engine rather than reimplementing the protocol is
    // the same decision the node agent and the Windows client both made:
    // an upstream fix becomes a version bump instead of a rewrite.
    implementation("com.wireguard.android:tunnel:1.0.20230706")

    // xray-core, compiled by gomobile and then split in two: Gradle
    // rejects a local .aar inside a library module, but takes the jar and
    // the native library separately. Built by
    // apps/mobile/scripts/build-xray-aar.sh rather than committed --
    // see the note in .gitignore.
    implementation(files("libs/xray-classes.jar"))

    implementation(project(":tauri-android"))
}
