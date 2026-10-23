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
      entries: [String]?, statuses: [BuildMachineStatus]?, tailscale: Bool?, updates: [String: MachineUpdatePhase] = [:],
      installs: [String: StimInstall] = [:],
      poolDisabled: [String: [String]]? = nil, failure: String? = nil, hosted: [HostedOnMachine] = [],
      linux: Set<String> = [],
      settingsReadFailure: String? = nil, showsThisMac: Bool = false
    ) -> some View {
      BuildMachinesContent(
        entries: entries, statuses: statuses,
        hosts: [
          BuildMachineStatus(machine: "mini", state: .approved), BuildMachineStatus(machine: "janics-mac-mini", state: .approved),
        ], updates: updates, installs: installs,
        working: nil, progress: nil, refreshing: false, failure: failure, tailscaleRunning: tailscale,
        settingsReadFailure: settingsReadFailure, canAsk: true,
        addDisabled: false,
        updatesAutomatically: .constant(false), add: {}, ask: { _ in }, update: { _ in },
        remove: { _ in }, poolDisabled: poolDisabled, hostsSimulators: { !linux.contains($0) }, hosted: { _ in hosted },
        showsThisMac: showsThisMac, thisMacName: "MacBook Pro",
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

    private func layers() throws -> [BuildMachineStatus] {
      try JSONDecoder().decode(
        [BuildMachineStatus].self,
        from: Data(
          #"""
          [{"machine":"mini","state":"unreachable","dnsName":"mini.tail1234.ts.net","deviceId":"a1b2c3d4",
            "diagnosis":{"layer":"server","code":"server-not-ready","title":"Server not ready",
              "message":"stim-server on mini is running but is not serving clients (HTTP 503). It cannot read its Stim home, usually because the disk holding ~/.stim is disconnected or not responding.",
              "remedy":"Check the disk that holds the Stim home on mini (reconnect or wake an external drive); stim-server serves again by itself once it answers. `stim-server service status` there shows the exact reason."}},
           {"machine":"studio","state":"unreachable","dnsName":"studio.tail1234.ts.net","deviceId":"e5f6a7b8",
            "diagnosis":{"layer":"server","code":"server-not-running","title":"Server not running",
              "message":"Tailscale and the serve route on studio work, but nothing listens behind the route: stim-server is not running there (HTTP 502).",
              "remedy":"On studio, run `stim-server service status`; `stim-server service install --serve` starts it and keeps it running."}},
           {"machine":"air","state":"unreachable","dnsName":"air.tail1234.ts.net","deviceId":"c9d0e1f2",
            "diagnosis":{"layer":"peer","code":"peer-offline","title":"Mac is offline",
              "message":"air is offline on Tailscale (last seen 3 h ago).",
              "remedy":"Wake air or check that it is powered on, connected to a network and signed in to Tailscale, then run `stim doctor` again."}}]
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

    private func decode(_ json: String) throws -> BuildMachineStatus {
      try JSONDecoder().decode(BuildMachineStatus.self, from: Data(json.utf8))
    }

    private func findings(_ json: String) throws -> [DoctorReport.Finding] {
      try JSONDecoder().decode([DoctorReport.Finding].self, from: Data(json.utf8))
    }

    /// The old-worker report of janics-mac-mini-2: no licenses reported, so the SDK packages are blockers.
    private func strictSdk() throws -> BuildMachineStatus {
      try decode(
        #"""
        {"machine":"janics-mac-mini-2","state":"approved","offloadable":false,"dnsName":"janics-mac-mini-2.tail1234.ts.net",
         "problems":[{"code":"ndk","reason":"Android: no NDK 27.1.12297006 there"},
                     {"code":"compile-sdk","reason":"Android: no platform android-36 there"}],
         "capacity":{"running":0,"max":1,"diskFreeBytes":859830480896,"cpus":12,"loadPerCore":0.5,"maxLoadPerCore":2,"builds":0,"maxBuilds":0,
                     "memoryUsedBytes":9413672960,"memoryTotalBytes":34359738368}}
        """#)
    }

    /// The same machine once its stim-server reports accepted licenses.
    private func noted() throws -> BuildMachineStatus {
      try decode(
        #"""
        {"machine":"janics-mac-mini-2","state":"approved","offloadable":true,"dnsName":"janics-mac-mini-2.tail1234.ts.net",
         "notes":[{"code":"ndk","reason":"Android: NDK 27.1.12297006 is not installed there; Gradle downloads it on the first build (about 1-2 GB)"},
                  {"code":"compile-sdk","reason":"Android: platform android-36 is not installed there; Gradle downloads it on the first build"}],
         "capacity":{"running":0,"max":1,"diskFreeBytes":859830480896,"cpus":12,"loadPerCore":0.5,"maxLoadPerCore":2,"builds":0,"maxBuilds":0,
                     "memoryUsedBytes":9413672960,"memoryTotalBytes":34359738368}}
        """#)
    }

    private func notedMini() throws -> BuildMachineStatus {
      var status = try noted()
      status.machine = "janics-mac-mini"
      return status
    }

    private let sdkFindings =
      #"""
      [{"code":"build-machine-ndk","level":"note","title":"Remote machine janics-mac-mini-2 downloads this project's NDK on its first Android build",
        "detail":"The build goes there anyway: NDK 27.1.12297006 is not installed there; Gradle downloads it on the first build (about 1-2 GB).",
        "fix":"On janics-mac-mini-2, install the package now so the first build does not download it:\n/Users/janic/Library/Android/sdk/cmdline-tools/latest/bin/sdkmanager \"ndk;27.1.12297006\""},
       {"code":"build-machine-compile-sdk","level":"note","title":"Remote machine janics-mac-mini-2 downloads this project's Android compile platform on its first Android build",
        "detail":"The build goes there anyway: platform android-36 is not installed there; Gradle downloads it on the first build.",
        "fix":"On janics-mac-mini-2, install the package now so the first build does not download it:\n/Users/janic/Library/Android/sdk/cmdline-tools/latest/bin/sdkmanager \"platforms;android-36\""}]
      """#

    private func ledgerLine(
      _ id: String, minutesAgo: Double, platform: String, outcome: String = "succeeded", durationMs: Int,
      failure: String = ""
    ) -> String {
      let ts = Int((Date().timeIntervalSince1970 - minutesAgo * 60) * 1000)
      return """
        {"ts":\(ts),"src":"builds","level":"info","msg":"m","event":"build","id":"\(id)","startedAt":\(ts - durationMs),\
        "project":"/Users/me/dev/mobile-app","workspace":"w--1","branch":"feat/checkout","platform":"\(platform)",\
        "configuration":"Debug","placement":{"where":"offloaded","machine":"janics-mac-mini-2"},\
        "cache":{"result":"miss","key":"k","fingerprint":"f"},"durationMs":\(durationMs),\
        "phases":{"prepare":2000,"compile":\(durationMs - 2000)},"offloadPhases":{"sync":9000,"build":\(durationMs - 20000)},\
        "outcome":"\(outcome)"\(failure),"stimVersion":"1.26.0"}
        """
    }

    private var machineBuilds: [LedgerBuild] {
      BuildLedger.parse(
        Data(
          [
            ledgerLine("a", minutesAgo: 12, platform: "ios", durationMs: 205_000),
            ledgerLine(
              "b", minutesAgo: 70, platform: "android", outcome: "failed", durationMs: 140_000,
              failure:
                #","failure":{"code":"STIM_GRADLE_FAILED","message":"Gradle exited 1 on janics-mac-mini-2","remedy":"Run stim logs --errors","phase":"compile"}"#
            ),
            ledgerLine("c", minutesAgo: 300, platform: "ios", durationMs: 188_000),
          ].joined(separator: "\n").utf8))
    }

    @MainActor private func page(
      _ detail: MachineDetail, status: BuildMachineStatus?, install: StimInstall? = nil, update: MachineUpdatePhase? = nil,
      builds: [LedgerBuild] = []
    ) -> some View {
      MachineDetailPage(
        entry: detail.entry, detail: detail, status: status, capabilities: ["Builds", "Simulators"], working: false,
        progress: nil, canAsk: true, hosted: [], builds: builds,
        buildsNote: "No recorded build ran on this machine yet.", update: update, install: install, back: {}, ask: {},
        startUpdate: {},
        stopHosted: { _ in }, remove: {}, showsToggles: true,
        toggles: BuildMachinePoolToggles(
          machine: detail.entry, poolDisabled: ["build": [], "device": []], hostsSimulators: true, disabled: false,
          setPool: { _, _, _ in })
      )
      .font(.stim(.body))
      .foregroundStyle(Palette.text)
      .background(Palette.background)
      .frame(width: 780, height: builds.isEmpty ? 560 : 1500)
    }

    @MainActor private func detailFixtures() throws -> [(String, AnyView)] {
      var android = MachineDetail.Input(entry: "janics-mac-mini-2", status: try noted())
      android.android = .loaded(try noted(), try findings(sdkFindings))
      android.host = BuildMachineStatus(machine: "janics-mac-mini-2", state: .approved)
      android.thisMacVersion = "1.25.0"
      android.serverVersion = "1.25.0"
      var strict = MachineDetail.Input(entry: "janics-mac-mini-2", status: try strictSdk())
      strict.thisMacVersion = "1.25.0"
      strict.serverVersion = "1.25.0"
      strict.android = .loading
      var newer = MachineDetail.Input(entry: "janics-mac-mini", status: try mismatch()[0])
      newer.install = .blocked(
        StimInstallBlock(
          reason: "janics-mac-mini runs Stim 1.26.0, newer than this Mac (1.25.0). Update Stim Desktop to match.",
          action: .checkForUpdates))
      newer.thisMacVersion = "1.25.0"
      newer.serverVersion = "1.26.0"
      var mixed = MachineDetail.Input(
        entry: "janics-mac-mini",
        status: try decode(
          #"""
          {"machine":"janics-mac-mini","state":"approved","offloadable":false,"dnsName":"janics-mac-mini.tail1234.ts.net",
           "problems":[{"code":"stim-build","reason":"Stim build 5773060690f40277 there, d9b8bdb39828c9a0 here"},
                       {"code":"cocoapods","reason":"iOS: CocoaPods 1.17.0 there, 1.16.2 here"},
                       {"code":"jdk","reason":"Android: JDK 25 there, 17 here"}]}
          """#))
      mixed.install = newer.install
      mixed.android = .loaded(
        try decode(
          #"{"machine":"janics-mac-mini","state":"approved","offloadable":false,"problems":[{"code":"jdk","reason":"JDK 25 there, 17 here"}]}"#
        ),
        try findings(
          #"""
          [{"code":"build-machine-jdk","level":"cost","title":"Remote machine janics-mac-mini runs another JDK major version",
            "detail":"Builds fall back to this machine: JDK 25 there, 17 here.",
            "fix":"On janics-mac-mini, install JDK 17; Stim uses it automatically, no restart needed:\nbrew install --cask zulu@17"}]
          """#))
      let down = try layers()[0]
      return [
        ("detail-notes", AnyView(page(MachineDetail(android), status: try noted()))),
        (
          "detail-builds",
          AnyView(page(MachineDetail(android), status: try noted(), builds: machineBuilds))
        ),
        ("detail-old-worker", AnyView(page(MachineDetail(strict), status: try strictSdk()))),
        ("detail-update-this-mac", AnyView(page(MachineDetail(mixed), status: mixed.status, install: newer.install))),
        (
          "detail-unreachable",
          AnyView(page(MachineDetail(MachineDetail.Input(entry: "mini", status: down)), status: down))
        ),
      ]
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
          AnyView(
            content(
              entries: ["janics-mac-mini"], statuses: try mismatch(), tailscale: true,
              installs: ["janics-mac-mini": .install], poolDisabled: pools))
        ),
        (
          "install-remote-newer",
          AnyView(
            content(
              entries: ["janics-mac-mini"], statuses: try mismatch(), tailscale: true,
              installs: [
                "janics-mac-mini": .blocked(
                  StimInstallBlock(
                    reason:
                      "janics-mac-mini runs Stim 1.25.0, newer than this Mac (1.24.0). Update Stim Desktop to match.",
                    action: .checkForUpdates))
              ], poolDisabled: pools))
        ),
        (
          "install-needs-setting",
          AnyView(
            content(
              entries: ["janics-mac-mini"], statuses: try mismatch(), tailscale: true,
              installs: [
                "janics-mac-mini": .blocked(
                  StimInstallBlock(
                    reason:
                      "janics-mac-mini takes only npm releases, and this Mac runs a checkout build. To allow it, run `stim settings set server.acceptClientBuilds true` on janics-mac-mini.",
                    action: .runOnRemote("stim settings set server.acceptClientBuilds true")))
              ], poolDisabled: pools))
        ),
        (
          "install-cannot-update",
          AnyView(
            content(
              entries: ["janics-mac-mini"], statuses: try mismatch(), tailscale: true,
              installs: [
                "janics-mac-mini": .blocked(
                  StimInstallBlock(
                    reason:
                      "stim-server on janics-mac-mini cannot be updated from here yet. Update it once there with `stim-server service update`.",
                    action: .runOnRemote("stim-server service update")))
              ], poolDisabled: pools))
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
          "pools-linux",
          AnyView(
            content(
              entries: ["mini", "studio"], statuses: try busy(), tailscale: true,
              poolDisabled: ["build": [], "device": []], linux: ["studio"]))
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
          "settings-unreadable-this-mac",
          AnyView(
            content(
              entries: nil, statuses: nil, tailscale: true,
              settingsReadFailure: "The local stim-server is not ready to read settings for this Stim home.",
              showsThisMac: true))
        ),
        (
          "settings-unreadable",
          AnyView(
            content(
              entries: nil, statuses: nil, tailscale: true,
              settingsReadFailure: "The local stim-server is not ready to read settings for this Stim home."))
        ),
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
        ("layers", AnyView(content(entries: ["mini", "studio", "air"], statuses: try layers(), tailscale: true))),
        (
          "rows-sdk-packages",
          AnyView(
            content(
              entries: ["janics-mac-mini-2", "janics-mac-mini"], statuses: [try strictSdk(), try notedMini()],
              tailscale: true, poolDisabled: ["build": [], "device": []]))
        ),
        ("busy", AnyView(content(entries: ["mini", "studio"], statuses: try busy(), tailscale: true))),
        ("tailscale-off", AnyView(content(entries: ["mini", "studio"], statuses: try statuses(), tailscale: false))),
        ("empty-tailscale-off", AnyView(content(entries: [], statuses: [], tailscale: false))),
        ("empty-checking", AnyView(content(entries: [], statuses: [], tailscale: nil))),
      ]
      for (name, view) in fixtures + (try detailFixtures()) {
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
