// swift-tools-version:6.0
import PackageDescription

let minimumMacOSVersion = "14.0"

#if compiler(>=6.4)
  // SwiftPM 6.4 / Swift Build records the deployment target as the LC_BUILD_VERSION SDK;
  // macOS 26 requires SDK 26 or newer for Liquid Glass. 27.0 is the SDK shipped with the 6.4 toolchain.
  let desktopLinkerSettings: [LinkerSetting] = [
    .unsafeFlags(["-Xlinker", "-platform_version", "-Xlinker", "macos", "-Xlinker", minimumMacOSVersion, "-Xlinker", "27.0"])
  ]
#else
  let desktopLinkerSettings: [LinkerSetting] = []
#endif

let package = Package(
  name: "StimDesktop",
  platforms: [.macOS(minimumMacOSVersion)],
  products: [
    .executable(name: "StimDesktop", targets: ["StimDesktop"])
  ],
  dependencies: [
    .package(url: "https://github.com/cpisciotta/xcbeautify.git", exact: "3.2.1"),
    .package(url: "https://github.com/pointfreeco/swift-snapshot-testing.git", exact: "1.19.6"),
    .package(url: "https://github.com/airbnb/lottie-spm.git", exact: "4.6.1"),
    .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0"),
    // 9.29.2, pinned by revision: its Package@swift-6.1 manifest depends on KSCrash by revision, which Swift 6.1's
    // SwiftPM rejects under a version requirement ("depends on an unstable-version package").
    .package(url: "https://github.com/getsentry/sentry-cocoa", revision: "8689e780a295dfdc6501ac0dbb502461e16d6551"),
  ],
  targets: [
    .target(name: "StimKit", dependencies: [.product(name: "XcbeautifyLib", package: "xcbeautify")]),
    .target(name: "StimStores", dependencies: ["StimKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
    .target(name: "SimulatorFrames", dependencies: ["StimKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
    .target(name: "EmulatorFrames", dependencies: ["StimKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
    .target(name: "WebFrames", dependencies: ["StimKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
    .executableTarget(
      name: "StimDesktop",
      dependencies: [
        "StimKit", "StimStores", "SimulatorFrames", "EmulatorFrames", "WebFrames", .product(name: "Lottie", package: "lottie-spm"),
        .product(name: "Sparkle", package: "Sparkle"), .product(name: "Sentry", package: "sentry-cocoa"),
      ],
      swiftSettings: [.swiftLanguageMode(.v5)],
      linkerSettings: desktopLinkerSettings
    ),
    .testTarget(
      name: "StimKitTests",
      dependencies: ["StimKit"],
      resources: [.copy("Fixtures")]
    ),
    .testTarget(
      name: "VisualFixtureTests",
      dependencies: ["StimDesktop", .product(name: "SnapshotTesting", package: "swift-snapshot-testing")],
      exclude: ["__Snapshots__"],
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
    .testTarget(name: "StimStoresTests", dependencies: ["StimStores", "StimKit"]),
    .testTarget(name: "WebFramesTests", dependencies: ["WebFrames"]),
    .testTarget(name: "SimulatorFramesTests", dependencies: ["SimulatorFrames"]),
    .testTarget(name: "EmulatorFramesTests", dependencies: ["EmulatorFrames"]),
  ]
)
