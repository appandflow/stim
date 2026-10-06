#if DEBUG
  import Foundation
  import StimKit
  import SwiftUI

  enum AddMachineFixture: String, CaseIterable, Identifiable {
    case tailscaleMissing, tailscaleStopped, peerOffline, ready
    case chooseBoth, chooseBuilds, chooseHosted, alreadyApproved
    case command, expired, starting, awaitingApproval, awaitingPermission, approved
    case noAnswer, stepFailed, serverTooOld, requestLapsed, grantedOther, funneled, permissionSkipped, noWorkspace
    var id: Self { self }

    @MainActor func make() -> AddMachineModel {
      let now = Date(timeIntervalSince1970: 1_791_284_400)
      let issued = self == .expired ? now.addingTimeInterval(-1801) : self == .noAnswer ? now.addingTimeInterval(-181) : now
      let ticket = SetupTicket.generate(now: issued, randomBytes: { bytes in bytes = Array(0..<32) })
      let status = Data(
        """
        {"BackendState":"\(self == .tailscaleStopped ? "Stopped" : "Running")",
         "Self":{"ID":"nSelf","HostName":"MacBook-Pro","DNSName":"macbook.tail.test."},
         "Peer":{"one":{"ID":"nMini","HostName":"janics-mac-mini","DNSName":"mini.tail.test.","OS":"macOS","Online":\(self != .peerOffline)},
         "two":{"ID":"nAir","HostName":"old-air","DNSName":"old-air.tail.test.","OS":"macOS","Online":false}}}
        """.utf8)
      let client = Tailnet.selfNode(statusJSON: status)!
      let mac = Tailnet.peers(statusJSON: status).first!.mac
      var wizard = SetupWizard(hasWorkspace: self != .noWorkspace)
      if ![.tailscaleMissing, .tailscaleStopped, .peerOffline, .ready].contains(self) {
        _ = wizard.apply(.macChosen(mac), now: now)
        if self == .chooseBuilds { _ = wizard.apply(.capabilitiesChanged([.build]), now: now) }
        if self == .chooseHosted { _ = wizard.apply(.capabilitiesChanged([.deviceHost]), now: now) }
        var build = BuildMachineStatus(machine: "mini", state: .pending, deviceId: "build-id")
        var host = BuildMachineStatus(machine: "mini", state: .pending, deviceId: "host-id")
        if self == .alreadyApproved || self == .approved || self == .permissionSkipped {
          build.state = .approved
          host.state = .approved
          host.host = .init(name: "janics-mac-mini", screenRecording: self != .permissionSkipped, accessibility: true)
        }
        _ = wizard.apply(.doctorReported(build: build, host: host), now: now)
        if ![.chooseBoth, .chooseBuilds, .chooseHosted, .alreadyApproved].contains(self) {
          _ = wizard.apply(.next(ticket), now: issued)
          if ![.command, .expired, .noAnswer, .noWorkspace].contains(self) {
            var steps: [SetupJournal.Step] = [
              .init(id: "preflight", state: .ok, title: "Tailnet node verified"),
              .init(id: "server", state: .ok, title: "stim-server 1.16.0 installed"),
              .init(id: "host", state: .ok, title: "Stim Host installed"),
              .init(id: "service", state: .ok, title: "LaunchAgent dev.stim.server running"),
              .init(id: "route", state: .ok, title: "tailnet route https 7443 (no Funnel)"),
              .init(id: "approve", state: .running, title: "Approve MacBook-Pro", detail: "Answer y/N in Terminal"),
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
            case .requestLapsed: build.state = .revoked
            case .grantedOther: grants = [.init(capability: .build, id: "other-request")]
            case .awaitingPermission, .approved, .permissionSkipped:
              steps[5].state = .ok
              grants = [.init(capability: .build, id: "build-id"), .init(capability: .deviceHost, id: "host-id")]
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
              done = self != .awaitingPermission
            default: break
            }
            let journal = SetupJournal(
              nodeId: client.id, ticket: ticket, capabilities: wizard.capabilities,
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
          version: { "1.16.0" }, now: { now }, ticket: { _ in ticket }), wizard: wizard)
      let health = try! JSONDecoder().decode(
        Tailnet.Health.self, from: Data("{\"server\":\"stim-server\",\"version\":\"1.16.0\",\"protocol\":1}".utf8))
      model.configureFixture(
        status: self == .tailscaleMissing ? nil : status, health: [mac.id: health], selfNode: client, ticket: ticket)
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
