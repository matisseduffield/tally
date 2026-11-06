import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.matisseduffield.tally"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.matisseduffield.tally"
        minSdk = 27
        targetSdk = 36
        // CI overrides these from the release tag (VERSION_NAME / VERSION_CODE
        // env) so the built APK's version always matches the tag it ships under
        // — a mismatch would make the app see itself as perpetually outdated.
        versionCode = (System.getenv("VERSION_CODE") ?: "10000").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "1.0.0"
    }

    // The converter itself is the web page in ../web, bundled as app assets so
    // the browser preview and the phone app always run the same file.
    sourceSets["main"].assets.srcDirs("../web")

    signingConfigs {
        create("release") {
            // Local builds: untracked keystore.properties next to the repo root.
            // CI: KEYSTORE_* environment variables fed from GitHub secrets.
            val propsFile = rootProject.file("keystore.properties")
            if (propsFile.exists()) {
                val props = Properties().apply { propsFile.inputStream().use { load(it) } }
                storeFile = rootProject.file(props.getProperty("storeFile"))
                storePassword = props.getProperty("storePassword")
                keyAlias = props.getProperty("keyAlias")
                keyPassword = props.getProperty("keyPassword")
            } else {
                val ksPath = System.getenv("KEYSTORE_PATH")
                if (ksPath != null) {
                    storeFile = File(ksPath)
                    storePassword = System.getenv("KEYSTORE_PASSWORD")
                    keyAlias = System.getenv("KEY_ALIAS")
                    keyPassword = System.getenv("KEY_PASSWORD")
                }
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            signingConfig = signingConfigs.getByName("release")
        }
    }

    // Two distribution channels: "github" self-updates from the public releases
    // repo; "play" ships without the self-updater (Play policy forbids apps
    // updating themselves) and updates through the store instead.
    flavorDimensions += "dist"
    productFlavors {
        create("github") {
            dimension = "dist"
            buildConfigField("boolean", "SELF_UPDATER", "true")
        }
        create("play") {
            dimension = "dist"
            buildConfigField("boolean", "SELF_UPDATER", "false")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.webkit)
}
