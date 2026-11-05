#if DEBUG
  import AppKit
  import SwiftUI
  import XCTest

  @testable import StimDesktop

  final class AddMachineScreenshotTests: XCTestCase {
    @MainActor func testWizardScreenshots() throws {
      guard let directory = ProcessInfo.processInfo.environment["STIM_WIZARD_SHOTS"] else {
        throw XCTSkip("Set STIM_WIZARD_SHOTS to render wizard fixtures.")
      }
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      for fixture in AddMachineFixture.allCases {
        for dark in [false, true] {
          let renderer = ImageRenderer(
            content: AddMachineSheet(model: fixture.make())
              .environment(\.colorScheme, dark ? .dark : .light)
              .environment(\.locale, Locale(identifier: "en_US"))
              .environment(\.timeZone, TimeZone(secondsFromGMT: 0)!))
          renderer.scale = 2
          let image = try XCTUnwrap(renderer.cgImage, "\(fixture.rawValue) did not render")
          let png = try XCTUnwrap(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
          try png.write(
            to: URL(fileURLWithPath: directory).appendingPathComponent("\(fixture.rawValue)-\(dark ? "dark" : "light").png"))
        }
      }
    }
  }
#endif
