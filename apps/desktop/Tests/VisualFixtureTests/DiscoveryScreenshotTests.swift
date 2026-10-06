#if DEBUG
  import AppKit
  import StimKit
  import SwiftUI
  import XCTest

  @testable import StimDesktop

  final class DiscoveryScreenshotTests: XCTestCase {
    @MainActor func testDiscoveryScreenshots() throws {
      guard let directory = ProcessInfo.processInfo.environment["STIM_DISCOVERY_SHOTS"] else {
        throw XCTSkip("Set STIM_DISCOVERY_SHOTS to render discovery fixtures.")
      }
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      for type in DiscoveryType.allCases {
        for dark in [false, true] {
          let renderer = ImageRenderer(
            content: DiscoveryFixtureView(type: type)
              .environment(\.colorScheme, dark ? .dark : .light)
              .environment(\.locale, Locale(identifier: "en_US")))
          renderer.scale = 2
          let image = try XCTUnwrap(renderer.cgImage, "\(type.rawValue) did not render")
          let png = try XCTUnwrap(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
          try png.write(
            to: URL(fileURLWithPath: directory).appendingPathComponent("\(type.rawValue)-\(dark ? "dark" : "light").png"))
        }
      }
    }
  }
#endif
