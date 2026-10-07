#if DEBUG
  import AppKit
  import StimKit
  import SwiftUI
  import XCTest

  @testable import StimDesktop

  final class BuildMachinesScreenshotTests: XCTestCase {
    private func statuses() throws -> [BuildMachineStatus] {
      try JSONDecoder().decode(
        [BuildMachineStatus].self,
        from: Data(
          #"""
          [{"machine":"mini","state":"approved","offloadable":false,"dnsName":"mini.tail1234.ts.net",
            "reasons":["CocoaPods 1.17.0 there, 1.16.2 here"],
            "problems":[{"code":"cocoapods","reason":"CocoaPods 1.17.0 there, 1.16.2 here"}],
            "capacity":{"running":0,"max":1,"diskFreeBytes":825196154880,"cpus":10,"loadPerCore":0.6,"builds":0,"maxBuilds":2}},
           {"machine":"studio","state":"pending","deviceId":"a1b2c3d4","dnsName":"studio.tail1234.ts.net","expiresAt":"2099-01-01T21:05:00.000Z"}]
          """#.utf8))
    }

    @MainActor private func content(
      entries: [String], statuses: [BuildMachineStatus]?, tailscale: Bool, updates: [String: MachineUpdatePhase] = [:]
    ) -> some View {
      BuildMachinesContent(
        entries: entries, statuses: statuses, hosts: [BuildMachineStatus(machine: "mini", state: .approved)], updates: updates,
        working: nil, progress: nil, refreshing: false, failure: nil, tailscaleRunning: tailscale, canAsk: true,
        addDisabled: false, sampleExists: false,
        updatesAutomatically: .constant(false), add: {}, ask: { _ in }, update: { _ in }, showDetails: { _ in },
        remove: { _ in }, deleteSample: {}
      )
      .font(.stim(.body))
      .foregroundStyle(Palette.text)
      .background(Palette.background)
      .frame(width: 780, height: 560)
    }

    private func blocked() throws -> [BuildMachineStatus] {
      try JSONDecoder().decode(
        [BuildMachineStatus].self,
        from: Data(
          #"""
          [{"machine":"mini","state":"approved","offloadable":true,"dnsName":"mini.tail1234.ts.net"},
           {"machine":"studio","state":"approved","offloadable":false,"dnsName":"studio.tail1234.ts.net",
            "reasons":["Stim build 6bbe9103995f7eb6 there, e7749c9011f4d423 here","no CocoaPods there"],
            "problems":[{"code":"stim-build","reason":"Stim build 6bbe9103995f7eb6 there, e7749c9011f4d423 here"},
                        {"code":"cocoapods","reason":"no CocoaPods there"}]}]
          """#.utf8))
    }

    @MainActor func testBuildMachinesScreenshots() throws {
      guard let directory = ProcessInfo.processInfo.environment["STIM_BUILD_MACHINES_SHOTS"] else {
        throw XCTSkip("Set STIM_BUILD_MACHINES_SHOTS to render build machine fixtures.")
      }
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      let fixtures: [(String, AnyView)] = [
        ("empty", AnyView(content(entries: [], statuses: [], tailscale: true))),
        (
          "list", AnyView(content(entries: ["mini", "studio"], statuses: try statuses(), tailscale: true))
        ),
        (
          "lapsed",
          AnyView(
            content(
              entries: ["mini", "studio"],
              statuses: try JSONDecoder().decode(
                [BuildMachineStatus].self,
                from: Data(
                  #"""
                  [{"machine":"mini","state":"approved","offloadable":true,"dnsName":"mini.tail1234.ts.net"},
                   {"machine":"studio","state":"lapsed","deviceId":"a1b2c3d4","dnsName":"studio.tail1234.ts.net"}]
                  """#.utf8)),
              tailscale: true))
        ),
        (
          "update-failed",
          AnyView(
            content(
              entries: ["mini", "studio"], statuses: try blocked(), tailscale: true,
              updates: [
                "studio": .failed(
                  "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/stim-server - Not found\nnpm error 404 'stim-server@0.0.0-dev' is not in this registry. Not switching to it."
                )
              ]))
        ),
        ("tailscale-off", AnyView(content(entries: ["mini", "studio"], statuses: try statuses(), tailscale: false))),
        ("empty-tailscale-off", AnyView(content(entries: [], statuses: [], tailscale: false))),
      ]
      for (name, view) in fixtures {
        for dark in [false, true] {
          let host = NSHostingView(
            rootView: view.environment(\.colorScheme, dark ? .dark : .light)
              .environment(\.locale, Locale(identifier: "en_US")))
          host.frame = NSRect(x: 0, y: 0, width: 780, height: 560)
          host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
          let window = NSWindow(
            contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
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
