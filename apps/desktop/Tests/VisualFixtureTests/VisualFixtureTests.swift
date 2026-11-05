#if DEBUG
  import AppKit
  import StimKit
  import SwiftUI
  import XCTest

  @testable import StimDesktop

  final class VisualFixtureTests: XCTestCase {
    @MainActor func testWorkspaceCardScreenshots() async throws {
      guard let directory = ProcessInfo.processInfo.environment["STIM_WORKSPACE_SHOTS"] else {
        throw XCTSkip("Set STIM_WORKSPACE_SHOTS to render live and archived workspace cards.")
      }
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      for screen in [
        PlaygroundScreen.workspace, .archivedSidebar, .archivedWorkspace, .buildSheet, .archivedBuildSheet, .realArchiveSidebar,
        .realArchiveWorkspace, .realArchiveBuildSheet,
      ] {
        for scenario in screen == .archivedWorkspace ? [.ready, .empty, .error] : [PlaygroundScenario.ready] {
          for dark in [false, true] {
            let output = URL(fileURLWithPath: directory).appendingPathComponent(
              "\(screen.rawValue)-\(scenario.rawValue)-\(dark ? "dark" : "light").png")
            try await check(
              screen: screen, scenario: scenario, dark: dark,
              width: [.buildSheet, .archivedBuildSheet, .realArchiveBuildSheet].contains(screen)
                ? 980 : [.archivedSidebar, .realArchiveSidebar].contains(screen) ? 320 : 900,
              height: 1800, export: output)
            if ProcessInfo.processInfo.environment["STIM_ARCHIVE_REFERENCE_SHOTS"] == "1",
              scenario == .ready && [.archivedSidebar, .archivedWorkspace].contains(screen)
            {
              let name = "testArchived\(screen == .archivedSidebar ? "Sidebar" : "Workspace")\(dark ? "Dark" : "Light").1.png"
              try await check(
                screen: screen, scenario: scenario, dark: dark,
                width: screen == .archivedSidebar ? 320 : 900, nativeScale: 1,
                export: URL(fileURLWithPath: directory).appendingPathComponent(name))
            }
          }
        }
      }
    }

    @MainActor private func check(
      screen: PlaygroundScreen, scenario: PlaygroundScenario, dark: Bool, width: CGFloat, nativeScale: CGFloat? = nil,
      height: CGFloat = 640, export: URL,
      file: StaticString = #filePath, line: UInt = #line
    ) async throws {
      try await check(
        content: PlaygroundScreenView(
          screen: screen, scenario: scenario,
          fixtureDate: Date(
            timeIntervalSince1970: [.realArchiveSidebar, .realArchiveWorkspace, .realArchiveBuildSheet].contains(screen)
              ? 1791356400 : 946728000)),
        dark: dark, width: width, nativeScale: nativeScale, height: height, export: export, file: file, line: line)
    }

    @MainActor private func check<Content: View>(
      content: Content, dark: Bool, width: CGFloat, nativeScale: CGFloat? = nil,
      height: CGFloat = 640, export: URL,
      file: StaticString, line: UInt
    ) async throws {
      let zone = TimeZone(secondsFromGMT: 0)!
      var calendar = Calendar(identifier: .gregorian)
      calendar.timeZone = zone
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      XCTAssertNotNil(NSFont(name: FontFamily.sans, size: 14))
      let size = CGSize(width: width, height: height)
      let window = NSWindow(
        contentRect: CGRect(origin: .zero, size: size), styleMask: [.titled], backing: .buffered, defer: false)
      window.isReleasedWhenClosed = false
      defer { window.close() }
      let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
      window.appearance = appearance
      let view = NSHostingView(
        rootView:
          content
          .frame(width: size.width, height: size.height)
          .environment(\.locale, Locale(identifier: "en_US"))
          .environment(\.calendar, calendar)
          .environment(\.timeZone, zone)
          .environment(\.colorScheme, dark ? .dark : .light)
          .environment(\.dynamicTypeSize, .large)
          .transaction { $0.disablesAnimations = true })
      view.frame = CGRect(origin: .zero, size: size)
      view.appearance = appearance
      window.contentView = view
      window.setFrameOrigin(CGPoint(x: 40, y: 40))
      window.orderFront(nil)
      let scale = window.backingScaleFactor
      try XCTSkipUnless(scale == 1 || scale == 2, "Screenshot fixtures require a 1x or 2x native window backing scale.")
      try XCTSkipUnless(nativeScale == nil || scale == nativeScale, "Archive reference-sized exports require native 1x windows.")
      try await Task.sleep(for: .seconds(1))
      view.layoutSubtreeIfNeeded()
      guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
        XCTFail("The native fixture could not be captured.", file: file, line: line)
        return
      }
      view.cacheDisplay(in: view.bounds, to: bitmap)
      XCTAssertEqual(bitmap.pixelsWide, Int(width * scale))
      XCTAssertEqual(bitmap.pixelsHigh, Int(size.height * scale))
      let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
      try png.write(to: export)
    }
  }
#endif
