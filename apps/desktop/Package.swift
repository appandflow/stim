// swift-tools-version:6.0
import PackageDescription

let package = Package(
  name: "StimDesktop",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "StimDesktop", targets: ["StimDesktop"])
  ],
  targets: [
    .target(name: "StimKit"),
    .target(name: "SimulatorFrames", dependencies: ["StimKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
    .target(name: "EmulatorFrames", dependencies: ["StimKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
    .executableTarget(
      name: "StimDesktop",
      dependencies: ["StimKit", "SimulatorFrames", "EmulatorFrames"],
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
    .testTarget(
      name: "StimKitTests",
      dependencies: ["StimKit"],
      resources: [.copy("Fixtures")]
    ),
    .testTarget(name: "SimulatorFramesTests", dependencies: ["SimulatorFrames"]),
    .testTarget(name: "EmulatorFramesTests", dependencies: ["EmulatorFrames"]),
  ]
)
