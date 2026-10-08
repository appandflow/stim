#if DEBUG
  import AppKit
  import StimKit
  import SwiftUI
  import XCTest

  @testable import StimDesktop
  @testable import StimKit

  final class SettingsScreenshotTests: XCTestCase {
    @MainActor private func advanced() -> some View {
      let payload = try! JSONDecoder().decode(
        SettingsPayload.self,
        from: Data(
          #"{ "files": {}, "unknown": [], "settings": [{ "key": "recording.enabled", "value": true, "origin": "default", "layers": {} }] }"#
            .utf8))
      let settings = MachineSettingsStore(
        read: { payload }, write: { _, _, _, _ in .written(payload.entry("recording.enabled")!) })
      return AdvancedSettingsView(server: ServerController.shared, settings: settings, stimHome: NSHomeDirectory() + "/.stim")
    }

    @MainActor private func macsUsingThisMac() -> some View {
      let mini = PairedDevice(
        id: "a1b2c3d4", name: "studio", identity: .init(kind: "tailnet", nodeName: "studio", nodeId: "n1", user: nil),
        pairedAt: Date(), lastSeenAt: nil, capabilities: ["build"], requestedCapability: "build", pendingUntil: nil)
      return Form {
        ThisMacAccessSections(
          clients: [mini], sessions: [], stopping: [], review: { _ in }, revoke: { _ in }, stop: { _ in })
      }
      .formStyle(.grouped)
      .scrollContentBackground(.hidden)
    }

    @MainActor func testSettingsScreenshots() throws {
      guard let directory = ProcessInfo.processInfo.environment["STIM_SETTINGS_SHOTS"] else {
        throw XCTSkip("Set STIM_SETTINGS_SHOTS to render the settings fixtures.")
      }
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      let fixtures: [(String, AnyView)] = [
        ("advanced", AnyView(advanced())), ("remote-macs-using-this-mac", AnyView(macsUsingThisMac())),
      ]
      for (name, view) in fixtures {
        for dark in [false, true] {
          let host = NSHostingView(
            rootView: view.font(.stim(.body)).foregroundStyle(Palette.text).background(Palette.background)
              .environment(\.colorScheme, dark ? .dark : .light))
          host.frame = NSRect(x: 0, y: 0, width: 780, height: 640)
          host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
          let window = NSWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
          window.appearance = host.appearance
          window.contentView = host
          host.layoutSubtreeIfNeeded()
          RunLoop.current.run(until: Date().addingTimeInterval(0.3))
          let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds), "\(name) did not render")
          host.cacheDisplay(in: host.bounds, to: rep)
          let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
          try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png"))
        }
      }
    }
  }
#endif
