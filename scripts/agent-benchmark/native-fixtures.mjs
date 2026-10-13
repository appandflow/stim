import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const xcodeFixture = fileURLToPath(new URL('../../test/e2e/native/fixtures/xcode/', import.meta.url));
export const nativeBaselineText = 'native-revision-one';

export function createNativeFixture(platform, destination, { androidWrapper } = {}) {
  if (!['ios', 'android', 'macos'].includes(platform)) throw new Error(`Unsupported native platform: ${platform}`);
  if (existsSync(destination)) throw new Error(`Fixture already exists: ${destination}`);
  if (platform === 'android' && !androidWrapper) throw new Error('Android fixture needs a pinned Gradle wrapper');
  const write = (name, contents) => {
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  mkdirSync(destination, { recursive: true });
  write('.gitignore', '.build/\n.build-control/\n.gradle/\nbuild/\nmobile/build/\nlocal.properties\n*.app/\n');
  if (platform === 'ios') {
    cpSync(xcodeFixture, destination, { recursive: true });
    write('.stim.json', JSON.stringify({ ios: { scheme: 'NativeAcceptance', configuration: 'Debug' } }) + '\n');
    return {
      platform,
      framework: 'native-xcode',
      source: 'NativeAcceptance.swift',
      product: 'NativeAcceptance',
      bundleId: 'dev.stim.native.acceptance',
    };
  }
  if (platform === 'macos') {
    write(
      'Package.swift',
      `// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "NativeBenchmark",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "NativeBenchmark", targets: ["NativeBenchmark"])],
    targets: [.executableTarget(name: "NativeBenchmark")]
)
`,
    );
    write('Sources/NativeBenchmark/App.swift', readFileSync(join(xcodeFixture, 'NativeAcceptance.swift')));
    write(
      'Support/Info.plist',
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.stim.native.benchmark</string>
<key>CFBundleExecutable</key><string>NativeBenchmark</string>
<key>CFBundleName</key><string>NativeBenchmark</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
`,
    );
    write(
      '.stim.json',
      JSON.stringify({ macos: { product: 'NativeBenchmark', infoPlist: 'Support/Info.plist' } }) + '\n',
    );
    return {
      platform,
      framework: 'native-swiftpm',
      source: 'Sources/NativeBenchmark/App.swift',
      product: 'NativeBenchmark',
      bundleId: 'dev.stim.native.benchmark',
    };
  }
  for (const name of ['gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar']) {
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(androidWrapper, name), target);
  }
  write(
    'gradle/wrapper/gradle-wrapper.properties',
    `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.13-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`,
  );
  write(
    'settings.gradle.kts',
    `pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = "NativeBenchmark"
include(":mobile")
`,
  );
  write(
    'build.gradle.kts',
    `plugins {
  id("com.android.application") version "8.13.2" apply false
  id("org.jetbrains.kotlin.android") version "2.1.20" apply false
  id("org.jetbrains.kotlin.plugin.compose") version "2.1.20" apply false
}
`,
  );
  write(
    'gradle.properties',
    `org.gradle.configureondemand=false
org.gradle.configuration-cache=true
org.gradle.configuration-cache.problems=fail
org.gradle.workers.max=2
org.gradle.jvmargs=-Xmx3g
android.useAndroidX=true
`,
  );
  write(
    'mobile/build.gradle.kts',
    `plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
}
android {
  namespace = "dev.stim.nativebenchmark"
  compileSdk = 36
  defaultConfig { applicationId = "dev.stim.nativebenchmark"; minSdk = 24; targetSdk = 34; versionCode = 1; versionName = "1.0" }
  buildFeatures { compose = true }
  compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
  kotlinOptions { jvmTarget = "17" }
}
dependencies {
  implementation("androidx.activity:activity-compose:1.10.1")
  implementation("androidx.compose.foundation:foundation:1.8.3")
}
`,
  );
  write(
    'mobile/src/main/AndroidManifest.xml',
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="NativeBenchmark" android:theme="@android:style/Theme.Material.Light.NoActionBar"><activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>\n`,
  );
  write(
    'mobile/src/main/java/dev/stim/nativebenchmark/MainActivity.kt',
    `package dev.stim.nativebenchmark
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
class MainActivity : ComponentActivity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    setContent {
      val count = remember { mutableStateOf(0) }
      Column(Modifier.padding(24.dp)) {
        BasicText("${nativeBaselineText}")
        BasicText("Count: " + count.value)
        BasicText("Increment", Modifier.clickable { count.value += 1 }.padding(16.dp))
      }
    }
  }
}
`,
  );
  return {
    platform,
    framework: 'native-gradle',
    source: 'mobile/src/main/java/dev/stim/nativebenchmark/MainActivity.kt',
    product: 'mobile',
    bundleId: 'dev.stim.nativebenchmark',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform, destination, androidWrapper] = process.argv.slice(2);
  if (!destination)
    throw new Error('usage: native-fixtures.mjs <ios|android|macos> <new-directory> [gradle-wrapper-project]');
  process.stdout.write(
    JSON.stringify(createNativeFixture(platform, resolve(destination), { androidWrapper }), null, 2) + '\n',
  );
}
