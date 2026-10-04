#if DEBUG
  import AppKit
  import SnapshotTesting
  import SwiftUI
  import XCTest

  @testable import StimDesktop

  final class VisualFixtureTests: XCTestCase {
    @MainActor func testCompactNotifications() async throws {
      try await check(screen: .notifications, scenario: .longText, dark: false, width: 440)
    }

    @MainActor func testSimulatorControls() async throws {
      try await check(screen: .simulator, scenario: .ready, dark: true, width: 380)
    }

    @MainActor func testSimulatorErrorWrapping() async throws {
      try await check(screen: .simulator, scenario: .error, dark: false, width: 380)
    }

    @MainActor private func check(
      screen: PlaygroundScreen, scenario: PlaygroundScenario, dark: Bool, width: CGFloat,
      file: StaticString = #filePath, testName: String = #function, line: UInt = #line
    ) async throws {
      #if !arch(arm64)
        throw XCTSkip("Visual references require arm64.")
      #endif
      let version = ProcessInfo.processInfo.operatingSystemVersion
      try XCTSkipUnless(
        version.majorVersion == 27 && version.minorVersion == 0 && version.patchVersion == 0
          && ProcessInfo.processInfo.operatingSystemVersionString.contains("Build 26A428"),
        "Visual references require macOS 27.0 build 26A428; the macOS 15 CI lane has no matching references.")
      let locale = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
      let zone = NSTimeZone.default
      UserDefaults.standard.setVolatileDomain(
        ["AppleLocale": "en_US", "AppleLanguages": ["en_US"]], forName: UserDefaults.argumentDomain)
      NSTimeZone.default = TimeZone(secondsFromGMT: 0)!
      defer {
        UserDefaults.standard.setVolatileDomain(locale, forName: UserDefaults.argumentDomain)
        NSTimeZone.default = zone
      }
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      XCTAssertNotNil(NSFont(name: FontFamily.sans, size: 14))
      XCTAssertEqual(Locale.current.identifier, "en_US")
      let size = CGSize(width: width, height: 640)
      let window = NSWindow(
        contentRect: CGRect(origin: .zero, size: size), styleMask: [.titled], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      defer { window.close() }
      let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
      window.appearance = appearance
      let view = NSHostingView(
        rootView: PlaygroundScreenView(
          screen: screen, scenario: scenario, fixtureDate: Date(timeIntervalSince1970: 946728000)
        )
        .frame(width: size.width, height: size.height)
        .environment(\.locale, Locale(identifier: "en_US"))
        .environment(\.colorScheme, dark ? .dark : .light)
        .environment(\.dynamicTypeSize, .large)
        .transaction { $0.disablesAnimations = true })
      view.frame = CGRect(origin: .zero, size: size)
      view.appearance = appearance
      window.contentView = view
      window.setFrameOrigin(CGPoint(x: 40, y: 40))
      window.orderFront(nil)
      try XCTSkipUnless(window.backingScaleFactor == 1, "Visual references require a 1x native window backing scale.")
      try await Task.sleep(for: .seconds(1))
      view.layoutSubtreeIfNeeded()
      guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
        XCTFail("The native fixture could not be captured.", file: file, line: line)
        return
      }
      view.cacheDisplay(in: view.bounds, to: bitmap)
      XCTAssertEqual(bitmap.pixelsWide, Int(width))
      XCTAssertEqual(bitmap.pixelsHigh, 640)
      let image = NSImage(size: size)
      image.addRepresentation(bitmap)
      assertSnapshot(
        of: image, as: .image, record: ProcessInfo.processInfo.environment["STIM_RECORD_VISUAL_FIXTURES"] == "1" ? .all : .never,
        file: file, testName: testName, line: line)
    }
  }
#endif
