#if DEBUG
  import AppKit
  import StimKit
  import SwiftUI
  import XCTest

  @testable import StimDesktop

  final class TipScreenshotTests: XCTestCase {
    @MainActor func testTipScreenshots() throws {
      guard let directory = ProcessInfo.processInfo.environment["STIM_TIP_SHOTS"] else {
        throw XCTSkip("Set STIM_TIP_SHOTS to render tip fixtures.")
      }
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      for dark in [false, true] {
        for topic in TipTopic.allCases {
          try render(TipFixtureView(topic: topic), name: "tip-\(topic.rawValue)", dark: dark, directory: directory)
        }
        for variant in BuildMachineEmptyState.allCases {
          try render(BuildMachineEmptyFixtureView(variant: variant), name: "machine-\(variant)", dark: dark, directory: directory)
        }
      }
    }

    @MainActor private func render(_ view: some View, name: String, dark: Bool, directory: String) throws {
      let renderer = ImageRenderer(
        content:
          view
          .environment(\.colorScheme, dark ? .dark : .light)
          .environment(\.locale, Locale(identifier: "en_US")))
      renderer.scale = 2
      let image = try XCTUnwrap(renderer.cgImage, "\(name) did not render")
      let png = try XCTUnwrap(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
      try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png"))
    }
  }
#endif
