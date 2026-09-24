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
    .target(name: "SimulatorFrames", swiftSettings: [.swiftLanguageMode(.v5)]),
    .executableTarget(
      name: "StimDesktop",
      dependencies: ["StimKit", "SimulatorFrames"],
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
    .testTarget(
      name: "StimKitTests",
      dependencies: ["StimKit"],
      resources: [.copy("Fixtures")]
    ),
  ]
)
