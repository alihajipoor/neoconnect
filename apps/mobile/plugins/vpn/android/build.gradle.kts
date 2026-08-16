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
    // an upstream fix becomes a version bump instead of a rewrite -- and
    // this bump is that case arriving.
    //
    // 1.0.20260102, not 1.0.20230706, for Play's 16 KB page size rule.
    // This AAR ships libwg-go.so, libwg.so and libwg-quick.so prebuilt,
    // so unlike the Go and Rust libraries no NDK setting on our side can
    // change how they are linked -- the version IS the fix. Measured
    // from the published artifacts rather than inferred from dates:
    // 1.0.20230706 has 4096-byte load alignment on arm64-v8a and x86_64,
    // 1.0.20260102 has 16384 on both.
    //
    // The jump raises the library's own minSdk from 21 to 24, which
    // costs nothing here because this module already floors at 24 --
    // check that still holds before bumping again, since a silent rise
    // would drop older handsets that this product exists to serve.
    implementation("com.wireguard.android:tunnel:1.0.20260102")

    // xray-core, compiled by gomobile and then split in two: Gradle
    // rejects a local .aar inside a library module, but takes the jar and
    // the native library separately. Built by
    // apps/mobile/scripts/build-xray-aar.sh rather than committed --
    // see the note in .gitignore.
    implementation(files("libs/xray-classes.jar"))

    implementation(project(":tauri-android"))
}
