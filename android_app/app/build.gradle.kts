plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.depthforge.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.depthforge.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "2.0.0"
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    packaging {
        resources {
            excludes += "/META-INF/versions/9/OSGI-INF/MANIFEST.MF"
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.ui)
    implementation(libs.androidx.material)
    implementation(libs.material.icons.core)
    implementation(libs.material.icons.extended)
    implementation(libs.androidx.ui.tooling.preview)

    // Networking
    implementation(libs.retrofit)
    implementation(libs.converter.gson)
    implementation(libs.okhttp)
    implementation(libs.logging.interceptor)

    // Coroutine support for networking
    implementation(libs.kotlinx.coroutines.android)

    debugImplementation(libs.androidx.ui.tooling)
    testImplementation("junit:junit:4.13.2")
}
