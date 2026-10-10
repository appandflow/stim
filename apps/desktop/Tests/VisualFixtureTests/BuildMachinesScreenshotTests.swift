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
            "capacity":{"running":0,"max":1,"diskFreeBytes":825196154880,"cpus":10,"loadPerCore":0.6,"builds":0,"maxBuilds":2,
                         "memoryUsedBytes":9663676416,"memoryTotalBytes":17179869184}},
           {"machine":"studio","state":"pending","deviceId":"a1b2c3d4","dnsName":"studio.tail1234.ts.net","expiresAt":"2099-01-01T21:05:00.000Z"}]
          """#.utf8))
    }

    @MainActor private func content(
      entries: [String], statuses: [BuildMachineStatus]?, tailscale: Bool?, updates: [String: MachineUpdatePhase] = [:],
      poolDisabled: [String: [String]]? = nil, failure: String? = nil, hosted: [HostedOnMachine] = []
    ) -> some View {
      BuildMachinesContent(
        entries: entries, statuses: statuses,
        hosts: [
          BuildMachineStatus(machine: "mini", state: .approved), BuildMachineStatus(machine: "janics-mac-mini", state: .approved),
        ], updates: updates,
        working: nil, progress: nil, refreshing: false, failure: failure, tailscaleRunning: tailscale, canAsk: true,
        addDisabled: false,
        updatesAutomatically: .constant(false), add: {}, ask: { _ in }, update: { _ in },
        remove: { _ in }, poolDisabled: poolDisabled, hosted: { _ in hosted }, thisMacName: "MacBook Pro",
        thisMac: EmptyView()
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

    private func busy() throws -> [BuildMachineStatus] {
      try JSONDecoder().decode(
        [BuildMachineStatus].self,
        from: Data(
          #"""
          [{"machine":"mini","state":"approved","offloadable":false,"dnsName":"mini.tail1234.ts.net",
            "reasons":["busy (already running 1 offloaded build(s), its limit; load 1.4/core, 1 of 2 build slots busy)"],
            "problems":[{"code":"busy","reason":"busy (already running 1 offloaded build(s), its limit; load 1.4/core, 1 of 2 build slots busy)"}],
            "capacity":{"running":1,"max":1,"diskFreeBytes":824000000000,"cpus":10,"loadPerCore":1.4,"maxLoadPerCore":2,"builds":1,"maxBuilds":2,
                        "memoryUsedBytes":9663676416,"memoryTotalBytes":17179869184}},
           {"machine":"studio","state":"approved","offloadable":true,"dnsName":"studio.tail1234.ts.net",
            "capacity":{"running":0,"max":1,"diskFreeBytes":412000000000,"cpus":12,"loadPerCore":0.2,"maxLoadPerCore":2,"builds":0,"maxBuilds":2}}]
          """#.utf8))
    }

    private func mismatch() throws -> [BuildMachineStatus] {
      try JSONDecoder().decode(
        [BuildMachineStatus].self,
        from: Data(
          #"""
          [{"machine":"janics-mac-mini","state":"approved","offloadable":false,"dnsName":"janics-mac-mini.tail1234.ts.net",
            "reasons":["Stim build 5773060690f40277 there, d9b8bdb39828c9a0 here"],
            "problems":[{"code":"stim-build","reason":"Stim build 5773060690f40277 there, d9b8bdb39828c9a0 here"}],
            "capacity":{"running":0,"max":1,"diskFreeBytes":412000000000,"cpus":10,"loadPerCore":0.3,"maxLoadPerCore":2,"builds":0,"maxBuilds":2,
                        "memoryUsedBytes":9663676416,"memoryTotalBytes":17179869184}}]
          """#.utf8))
    }

    @MainActor func testBuildMachinesScreenshots() throws {
      guard let directory = ProcessInfo.processInfo.environment["STIM_BUILD_MACHINES_SHOTS"] else {
        throw XCTSkip("Set STIM_BUILD_MACHINES_SHOTS to render remote Mac fixtures.")
      }
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      let pools: [String: [String]] = ["build": [], "device": []]
      let fixtures: [(String, AnyView)] = [
        (
          "section-waiting-own",
          AnyView(
            content(
              entries: ["janics-mac-mini"], statuses: try mismatch(), tailscale: true,
              updates: ["janics-mac-mini": .waiting(builds: 0, hostedSessions: 2)], poolDisabled: pools,
              hosted: [
                HostedOnMachine(
                  workspace: "rn-tester", device: "iPhone 17 Pro", stop: StimCommand(["stop", "--slot", "default"], cwd: "/w"))
              ]))
        ),
        (
          "section-waiting-other",
          AnyView(
            content(
              entries: ["janics-mac-mini"], statuses: try mismatch(), tailscale: true,
              updates: ["janics-mac-mini": .waiting(builds: 0, hostedSessions: 1)], poolDisabled: pools))
        ),
        (
          "section-ready",
          AnyView(
            content(
              entries: ["janics-mac-mini"],
              statuses: try JSONDecoder().decode(
                [BuildMachineStatus].self,
                from: Data(
                  #"""
                  [{"machine":"janics-mac-mini","state":"approved","offloadable":true,"dnsName":"janics-mac-mini.tail1234.ts.net",
                    "capacity":{"running":0,"max":1,"diskFreeBytes":412000000000,"cpus":10,"loadPerCore":0.3,"maxLoadPerCore":2,
                                "builds":0,"maxBuilds":2,"memoryUsedBytes":9663676416,"memoryTotalBytes":17179869184}}]
                  """#.utf8)),
              tailscale: true, poolDisabled: pools))
        ),
        (
          "section-mismatch",
          AnyView(content(entries: ["janics-mac-mini"], statuses: try mismatch(), tailscale: true, poolDisabled: pools))
        ),
        (
          "section-updating",
          AnyView(
            content(
              entries: ["janics-mac-mini"], statuses: try mismatch(), tailscale: true,
              updates: ["janics-mac-mini": .restarting], poolDisabled: pools))
        ),
        (
          "pools-enabled",
          AnyView(content(entries: ["mini"], statuses: try busy(), tailscale: true, poolDisabled: ["build": [], "device": []]))
        ),
        (
          "pools-split",
          AnyView(
            content(
              entries: ["mini"], statuses: try busy(), tailscale: true,
              poolDisabled: ["build": ["local"], "device": ["mini"]]))
        ),
        (
          "pools-last-member",
          AnyView(
            content(
              entries: [], statuses: [], tailscale: true, poolDisabled: ["build": [], "device": []],
              failure: "Keep at least one approved member enabled in the build pool."))
        ),
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
        ("busy", AnyView(content(entries: ["mini", "studio"], statuses: try busy(), tailscale: true))),
        ("tailscale-off", AnyView(content(entries: ["mini", "studio"], statuses: try statuses(), tailscale: false))),
        ("empty-tailscale-off", AnyView(content(entries: [], statuses: [], tailscale: false))),
        ("empty-checking", AnyView(content(entries: [], statuses: [], tailscale: nil))),
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
