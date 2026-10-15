#if DEBUG
  import Foundation
  import StimKit
  import SwiftUI

  enum AddMachineFixture: String, CaseIterable, Identifiable {
    case tailscaleMissing, tailscaleStoppedApp, tailscaleStoppedCLI, noMac, allOffline, peerOffline, ready
    case chooseBoth, chooseBuilds, chooseHosted, chooseNone, alreadyApproved
    case command, expired, starting, awaitingApproval, awaitingPermission, approved
    case noAnswer, stepFailed, serverTooOld, requestLapsed, grantedOther, funneled, permissionSkipped, noWorkspace
    case toolsOK, toolsFixes, toolsBusy, toolsAndroid
    case testPreparingSample, sampleFailed, offloading, offloaded, localBuilding, testPassed, testFailed, testSkipped
    case summaryAuto, summaryNever, summaryUndo, summarySkippedAfterFailure
    case linuxChoose, linuxCommand, linuxApproved, linuxTools, linuxSummary
    case windowsChoose, windowsCommand
    var id: Self { self }

    private var target: TailnetOS {
      if [.windowsChoose, .windowsCommand].contains(self) { return .windows }
      return [.linuxChoose, .linuxCommand, .linuxApproved, .linuxTools, .linuxSummary].contains(self) ? .linux : .macOS
    }
    private var androidOnly: Bool { target != .macOS }

    @MainActor func make() -> AddMachineModel {
      let later: [Self] = [
        .toolsOK, .toolsFixes, .toolsBusy, .toolsAndroid, .testPreparingSample, .sampleFailed, .offloading, .offloaded,
        .localBuilding, .testPassed, .testFailed, .testSkipped, .summaryAuto, .summaryNever, .summaryUndo,
        .summarySkippedAfterFailure, .linuxTools, .linuxSummary,
      ]
      if later.contains(self) {
        let model = (androidOnly ? Self.linuxApproved : Self.approved).make()
        model.configureLaterFixture(self)
        return model
      }
      let now = Date(timeIntervalSince1970: 1_791_284_400)
      let issued = self == .expired ? now.addingTimeInterval(-1801) : self == .noAnswer ? now.addingTimeInterval(-181) : now
      let ticket = SetupTicket.generate(now: issued, randomBytes: { bytes in bytes = Array(0..<32) })
      let status = Data(
        """
        {"BackendState":"\(self == .tailscaleStoppedCLI ? "Stopped" : "Running")",
         "Self":{"ID":"nSelf","HostName":"MacBook-Pro","DNSName":"macbook.tail.test."},
         "Peer":{"one":{"ID":"nMini","HostName":"janics-mac-mini","DNSName":"mini.tail.test.","OS":"macOS","Online":\(self != .peerOffline && self != .allOffline)},
         "two":{"ID":"nAir","HostName":"old-air","DNSName":"old-air.tail.test.","OS":"macOS","Online":false},
         "three":{"ID":"nUbuntu","HostName":"ubuntu-runner","DNSName":"ubuntu.tail.test.","OS":"linux","Online":true},
         "four":{"ID":"nWin","HostName":"windows-pc","DNSName":"windows.tail.test.","OS":"windows","Online":true}}}
        """.utf8)
      let noMacStatus = Data(
        #"{"BackendState":"Running","Self":{"ID":"nSelf","HostName":"MacBook-Pro","DNSName":"macbook.tail.test."},"Peer":{}}"#
          .utf8)
      let client = Tailnet.selfNode(statusJSON: status)!
      let peers = Tailnet.peers(statusJSON: status)
      let mac = (androidOnly ? peers.first { $0.mac.os == target } : peers.first)!.mac
      let machine = mac.machine
      var wizard = SetupWizard(hasWorkspace: self != .noWorkspace)
      if ![.tailscaleMissing, .tailscaleStoppedApp, .tailscaleStoppedCLI, .noMac, .allOffline, .peerOffline, .ready].contains(
        self)
      {
        _ = wizard.apply(.macChosen(mac), now: now)
        if self == .chooseBuilds { _ = wizard.apply(.capabilitiesChanged([.build]), now: now) }
        if self == .chooseHosted { _ = wizard.apply(.capabilitiesChanged([.deviceHost]), now: now) }
        if self == .chooseNone { _ = wizard.apply(.capabilitiesChanged([]), now: now) }
        var build = BuildMachineStatus(machine: machine, state: .pending, deviceId: "build-id")
        var host = BuildMachineStatus(machine: machine, state: .pending, deviceId: "host-id")
        if androidOnly { host = BuildMachineStatus(machine: machine, state: .notAsked) }
        if self == .alreadyApproved || self == .approved || self == .permissionSkipped || self == .linuxApproved {
          build.state = .approved
          if !androidOnly {
            host.state = .approved
            host.host = .init(name: "janics-mac-mini", screenRecording: self != .permissionSkipped, accessibility: true)
          }
        }
        _ = wizard.apply(.doctorReported(build: build, host: host), now: now)
        if ![.chooseBoth, .chooseBuilds, .chooseHosted, .chooseNone, .alreadyApproved, .linuxChoose, .windowsChoose].contains(
          self)
        {
          _ = wizard.apply(.next(ticket), now: issued)
          if self == .linuxApproved {
            let steps: [SetupJournal.Step] = [
              .init(id: "preflight", state: .ok, title: "Tailnet node verified"),
              .init(id: "server", state: .ok, title: "stim-server 1.16.0 installed"),
              .init(id: "service", state: .ok, title: "systemd user service dev.stim.server running"),
              .init(id: "route", state: .ok, title: "Tailnet route", detail: "ubuntu.tail.test: https port 7443"),
              .init(id: "approve", state: .ok, title: "Access approval"),
              .init(
                id: "approve.build", state: .ok, title: "Approved MacBook-Pro (nSelf) for builds", detail: "request build-id"),
              .init(id: "tools", state: .ok, title: "Tools", detail: "Checked; installs nothing."),
            ]
            let journal = SetupJournal(
              ticket: ticket, capabilities: wizard.capabilities, steps: steps,
              granted: [.init(capability: .build, id: "build-id")], done: true)
            _ = wizard.apply(.journalAnswered(port: 7443, journal: journal), now: now)
            _ = wizard.apply(.entriesWritten, now: now)
            _ = wizard.apply(.doctorReported(build: build, host: host), now: now)
          } else if ![.command, .expired, .noAnswer, .noWorkspace, .linuxCommand, .windowsCommand].contains(self) {
            var steps: [SetupJournal.Step] = [
              .init(id: "preflight", state: .ok, title: "Tailnet node verified"),
              .init(id: "server", state: .ok, title: "stim-server 1.16.0 installed"),
              .init(id: "host", state: .ok, title: "Stim Host installed"),
              .init(id: "service", state: .ok, title: "LaunchAgent dev.stim.server running"),
              .init(id: "route", state: .ok, title: "tailnet route https 7443 (no Funnel)"),
              .init(id: "approve", state: .running, title: "Access approval", detail: "Waiting until expiry."),
            ]
            var grants: [SetupJournal.Grant] = []
            var done = false
            switch self {
            case .starting: steps = [.init(id: "preflight", state: .running, title: "Checking the tailnet node")]
            case .stepFailed:
              steps[3] = .init(
                id: "service", state: .failed, title: "Service install failed", detail: "LaunchAgent did not start",
                fix: "stim-server service status")
            case .serverTooOld:
              steps[1] = .init(
                id: "server", state: .failed, title: "Server is too old", detail: "1.15.0 predates setup support",
                fix: "npm install --global @stim-cli/server@1.16.0")
            case .funneled:
              steps[4] = .init(
                id: "route", state: .failed, title: "Public route refused", fix: "tailscale funnel --https=7443 off")
            case .requestLapsed: build.state = .lapsed
            case .grantedOther: grants = [.init(capability: .build, id: "other-request")]
            case .awaitingPermission, .approved, .permissionSkipped:
              steps[5].state = .ok
              grants = [.init(capability: .build, id: "build-id"), .init(capability: .deviceHost, id: "host-id")]
              steps.append(
                .init(
                  id: "approve.build", state: .ok, title: "Approved MacBook-Pro (nSelf) for builds", detail: "request build-id"))
              steps.append(
                .init(
                  id: "approve.device-host", state: .ok, title: "Approved MacBook-Pro (nSelf) for hosted simulators",
                  detail: "request host-id"))
              steps.append(
                .init(
                  id: "permissions.screenRecording", state: self == .permissionSkipped ? .skipped : .ok,
                  title: "Screen & System Audio Recording",
                  fix: self == .permissionSkipped ? "System Settings > Privacy & Security > Screen & System Audio Recording" : nil
                ))
              steps.append(
                .init(
                  id: "permissions.deviceControl", state: self == .awaitingPermission ? .running : .ok,
                  title: "Device Control and Data Access",
                  detail: self == .awaitingPermission ? "Click Allow on this Mac's screen" : nil))
              if self != .awaitingPermission {
                steps.append(.init(id: "tools", state: .ok, title: "Tools", detail: "Checked; installs nothing."))
                steps.append(.init(id: "tools.Xcode", state: .ok, title: "Xcode", detail: "Xcode 27.0"))
                steps.append(
                  .init(
                    id: "tools.Android SDK", state: .ok, title: "Android SDK",
                    detail: #"{"platforms":["android-36"],"buildTools":["36.0.0"],"ndk":["27.1.12297006"]}"#))
              }
              done = self != .awaitingPermission
            default: break
            }
            let journal = SetupJournal(
              ticket: ticket, capabilities: wizard.capabilities,
              steps: steps, granted: grants, done: done)
            _ = wizard.apply(.journalAnswered(port: 7443, journal: journal), now: now)
            _ = wizard.apply(.entriesWritten, now: now)
            _ = wizard.apply(.doctorReported(build: build, host: host), now: now)
          }
          _ = wizard.apply(.tick, now: now)
        }
      }
      let payload = try! JSONDecoder().decode(
        SettingsPayload.self, from: Data("{\"files\":{},\"settings\":[],\"unknown\":[]}".utf8))
      let model = AddMachineModel(
        checkout: "/fixture",
        dependencies: .init(
          status: { status }, health: { _, _ in nil }, journal: { _, _, _ in .notFound },
          doctor: { _, _, _ in throw FixtureError.unavailable }, readSettings: { payload }, writeSetting: { _, _ in },
          version: { "1.20.3" }, now: { now }, ticket: { _ in ticket }), wizard: wizard,
        sample: SampleBuildModel(
          dependencies: .init(
            sample: WizardSample(applicationSupport: URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support")),
            timings: { _ in throw FixtureError.unavailable },
            run: { _, _ in throw FixtureError.unavailable })))
      let health = try! JSONDecoder().decode(
        Tailnet.Health.self, from: Data("{\"server\":\"stim-server\",\"version\":\"1.16.0\",\"protocol\":1}".utf8))
      model.configureFixture(
        status: self == .tailscaleMissing || self == .tailscaleStoppedApp ? nil : self == .noMac ? noMacStatus : status,
        health: [mac.id: health],
        selfNode: client, ticket: ticket,
        install: self == .tailscaleMissing ? .none : self == .tailscaleStoppedCLI ? .cli : .app)
      if self == .allOffline { model.selectedId = nil }
      return model
    }

    private enum FixtureError: Error { case unavailable }
  }

  struct AddMachinePlayground: View {
    @State private var fixture = AddMachineFixture.ready
    @State private var model = AddMachineFixture.ready.make()

    var body: some View {
      VStack(spacing: 0) {
        Picker("Wizard state", selection: $fixture) {
          ForEach(AddMachineFixture.allCases) { Text($0.rawValue).tag($0) }
        }.padding(Space.md)
        AddMachineSheet(model: model).id(fixture)
      }
      .onChange(of: fixture) { model = fixture.make() }
    }
  }
#endif
