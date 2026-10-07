#if DEBUG
  import AppKit
  import SnapshotTesting
  import StimKit
  import SwiftUI
  import XCTest

  @testable import StimDesktop

  final class VisualFixtureTests: XCTestCase {
    @MainActor func testArchivedSidebarLight() async throws {
      try await check(screen: .archivedSidebar, scenario: .ready, dark: false, width: 320, nativeScale: 1)
    }

    @MainActor func testArchivedSidebarDark() async throws {
      try await check(screen: .archivedSidebar, scenario: .ready, dark: true, width: 320, nativeScale: 1)
    }

    @MainActor func testArchivedWorkspaceLight() async throws {
      try await check(screen: .archivedWorkspace, scenario: .ready, dark: false, width: 900, nativeScale: 1)
    }

    @MainActor func testArchivedWorkspaceDark() async throws {
      try await check(screen: .archivedWorkspace, scenario: .ready, dark: true, width: 900, nativeScale: 1)
    }

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

    @MainActor func testCompactNotifications() async throws {
      try await check(screen: .notifications, scenario: .longText, dark: false, width: 440)
    }

    @MainActor func testSimulatorControls() async throws {
      try await check(screen: .simulator, scenario: .ready, dark: true, width: 380)
    }

    @MainActor func testSimulatorErrorWrapping() async throws {
      try await check(screen: .simulator, scenario: .error, dark: false, width: 380)
    }

    @MainActor func testBuildHistoryRow() async throws {
      try await checkBuild()
    }

    @MainActor private func checkBuild(
      file: StaticString = #filePath, testName: String = #function, line: UInt = #line
    ) async throws {
      let now = Date(timeIntervalSince1970: 946728000)
      let fixture = try PlaygroundFixtures.make(.longText, now: now)
      let entry = try XCTUnwrap(fixture.environment.builds?.builds(for: "ios").first)
      try await check(
        content: BuildHistoryRow(entry: entry, now: now, open: {})
          .font(.stim(.callout))
          .padding(Space.lg)
          .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
          .padding(Space.xxl)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .background(Palette.sidebar),
        dark: false, width: WorkspaceDetail.inspectorWidth, retinaOnly: true, file: file, testName: testName, line: line)
    }

    @MainActor private func check(
      screen: PlaygroundScreen, scenario: PlaygroundScenario, dark: Bool, width: CGFloat, nativeScale: CGFloat? = nil,
      height: CGFloat = 640, export: URL? = nil,
      file: StaticString = #filePath, testName: String = #function, line: UInt = #line
    ) async throws {
      try await check(
        content: PlaygroundScreenView(
          screen: screen, scenario: scenario,
          fixtureDate: Date(
            timeIntervalSince1970: [.realArchiveSidebar, .realArchiveWorkspace, .realArchiveBuildSheet].contains(screen)
              ? 1791356400 : 946728000)),
        dark: dark, width: width, nativeScale: nativeScale, height: height, export: export, file: file, testName: testName,
        line: line)
    }

    @MainActor private func check<Content: View>(
      content: Content, dark: Bool, width: CGFloat, retinaOnly: Bool = false, nativeScale: CGFloat? = nil,
      height: CGFloat = 640, export: URL? = nil,
      file: StaticString, testName: String, line: UInt
    ) async throws {
      #if !arch(arm64)
        throw XCTSkip("Visual references require arm64.")
      #endif
      let version = ProcessInfo.processInfo.operatingSystemVersion
      try XCTSkipUnless(
        version.majorVersion == 27 && version.minorVersion == 0 && version.patchVersion == 0
          && ProcessInfo.processInfo.operatingSystemVersionString.contains("Build 26A428"),
        "Visual references require macOS 27.0 build 26A428; the macOS 15 CI lane has no matching references.")
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
      try XCTSkipUnless(scale == 1 || scale == 2, "Visual references require a 1x or 2x native window backing scale.")
      try XCTSkipUnless(nativeScale == nil || scale == nativeScale, "Archive references currently cover only native 1x windows.")
      try XCTSkipUnless(!retinaOnly || scale == 2, "Build row references currently cover only native 2x windows.")
      try await Task.sleep(for: .seconds(1))
      view.layoutSubtreeIfNeeded()
      guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
        XCTFail("The native fixture could not be captured.", file: file, line: line)
        return
      }
      view.cacheDisplay(in: view.bounds, to: bitmap)
      XCTAssertEqual(bitmap.pixelsWide, Int(width * scale))
      XCTAssertEqual(bitmap.pixelsHigh, Int(size.height * scale))
      if let export {
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: export)
        return
      }
      let image = NSImage(size: size)
      image.addRepresentation(bitmap)
      assertSnapshot(
        of: image, as: .image, named: scale == 2 ? "2x" : nil,
        record: ProcessInfo.processInfo.environment["STIM_RECORD_VISUAL_FIXTURES"] == "1" ? .all : .never,
        file: file, testName: testName, line: line)
    }
  }
#endif
