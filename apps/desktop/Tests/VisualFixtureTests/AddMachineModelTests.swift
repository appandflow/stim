import Foundation
import StimKit
import XCTest

@testable import StimDesktop

final class AddMachineModelTests: XCTestCase {
  @MainActor private final class Harness {
    var now = Date(timeIntervalSince1970: 1_791_284_400)
    var writes: [(String, String?)] = []
    var asks: [(Bool, String?)] = []
    var doctorPaths: [String] = []
    var steps: [String] = []
    var builds: [String] = []
    var hosts: [String] {
      get { builds }
      set { builds = newValue }
    }
    var mode: String?
    var modeOrigin: String? = "default"
    var grantReady = false
    var journalDone = false
    var statusState: String?
    var doctorDelay: Duration = .zero
    var doctorInFlight = 0
    var doctorMaxInFlight = 0
    var journalSteps: [SetupJournal.Step] = []
    var journalExpiryOffset: TimeInterval = 0
    var peerId = "nMini"
    var peers: String?
    var shouldFailHostWrite = false
    var shouldFailDoctor = false
    var toolProblems: [String: [[String: String]]] = [:]
    var toolCalls: [String] = []
    var remotes: [String: String] = [:]

    var status: Data {
      Data(
        """
        {"BackendState":"Running","Self":{"ID":"nSelf","HostName":"Laptop","DNSName":"laptop.tail.test."},
         "Peer":{\(peers ?? #""one":{"ID":"\#(peerId)","HostName":"Mini","DNSName":"mini.tail.test.","OS":"macOS","Online":true}"#)}}
        """.utf8)
    }
    func payload() throws -> SettingsPayload {
      let object: [String: Any] = [
        "files": [:], "unknown": [],
        "settings": [
          ["key": "remote.machines", "value": builds, "layers": [:]],
          ["key": "remote.buildMode", "value": mode ?? "auto", "origin": modeOrigin ?? "default", "layers": [:]],
        ] + remotes.map { ["key": $0.key, "value": $0.value, "layers": [:]] },
      ]
      return try JSONDecoder().decode(SettingsPayload.self, from: JSONSerialization.data(withJSONObject: object))
    }
    func report(platform: String? = nil) throws -> DoctorReport {
      func statuses(_ entries: [String], id: String) -> [[String: Any]] {
        entries.map {
          [
            "machine": $0, "state": statusState ?? (grantReady ? "approved" : "pending"), "deviceId": id,
            "dnsName": "mini.tail.test",
            "offloadable": true, "problems": toolProblems[platform ?? ""] ?? [],
          ]
        }
      }
      return try JSONDecoder().decode(
        DoctorReport.self,
        from: JSONSerialization.data(withJSONObject: [
          "project": "/fixture", "findings": [], "remoteMachines": statuses(builds, id: "b"),
          "deviceHosts": statuses(hosts, id: "h"),
        ]))
    }
    func machinesModel() -> BuildMachinesModel {
      let cli = Task { StimCLI(environment: [:], override: "/usr/bin/false") }
      return BuildMachinesModel(
        cli: cli,
        settings: MachineSettingsStore(
          read: { try await self.payload() },
          write: { _, _, _, _ in throw Failure.refused }),
        statsReader: StatsReader(cli: cli, server: { nil }),
        machineAccess: { _, _ in try self.report() })
    }
    var version = "1.21.0"
    var health: Tailnet.Health?

    var readServer: (doctor: (String) async throws -> DoctorReport, settings: () async throws -> SettingsPayload)?

    func make(workspace: Bool = true, sample: SampleBuildModel? = nil, machines: BuildMachinesModel? = nil) -> AddMachineModel {
      let model = AddMachineModel(
        checkout: workspace ? "/fixture" : nil,
        dependencies: .init(
          status: { self.status }, health: { _, _ in self.health },
          journal: { _, port, _ in
            guard port == 7447 else { return .notFound }
            return .journal(
              SetupJournal(
                ticket: SetupTicket.generate(now: self.now.addingTimeInterval(self.journalExpiryOffset)),
                capabilities: [.build, .deviceHost], steps: self.journalSteps,
                granted: self.grantReady ? [.init(capability: .build, id: "b"), .init(capability: .deviceHost, id: "h")] : [],
                done: self.journalDone))
          },
          doctor: { cwd, ask, ticket in
            self.doctorPaths.append(cwd)
            self.asks.append((ask, ticket))
            self.steps.append(ask ? "ask" : "readDoctor")
            self.doctorInFlight += 1
            self.doctorMaxInFlight = max(self.doctorMaxInFlight, self.doctorInFlight)
            defer { self.doctorInFlight -= 1 }
            if self.doctorDelay != .zero { try? await Task.sleep(for: self.doctorDelay) }
            if self.shouldFailDoctor { throw Failure.refused }
            if let server = self.readServer { return try await server.doctor(cwd) }
            return try self.report()
          },
          readSettings: {
            if let server = self.readServer { return try await server.settings() }
            return try self.payload()
          },
          writeSetting: { key, value in
            if key == "remote.machines", self.shouldFailHostWrite { throw Failure.refused }
            self.writes.append((key, value))
            self.steps.append(key)
            switch key {
            case "remote.buildMode": self.mode = value
            case "ios.remote", "android.remote": self.remotes[key] = value
            case "remote.machines":
              self.builds = try value.map { try JSONDecoder().decode([String].self, from: Data($0.utf8)) } ?? []
            default: break
            }
          }, version: { self.version },
          toolsDoctor: { _, platform in
            self.toolCalls.append(platform)
            return try self.report(platform: platform)
          }, now: { self.now },
          ticket: { SetupTicket.generate(now: $0) }), sample: sample)
      model.machines = machines
      return model
    }
    private enum Failure: Error { case refused }
  }

  @MainActor func testTailscaleIsCheckingUntilTheFirstReadReturns() async {
    let harness = Harness()
    let model = harness.make()
    XCTAssertTrue(model.checkingTailscale)
    await model.refreshPeers()
    XCTAssertFalse(model.checkingTailscale)
    XCTAssertEqual(model.reachability, .peerOffline)
  }

  @MainActor func testMacListSeparatesNoMacOfflineOnlyAndAvailable() async {
    let harness = Harness()
    let model = harness.make()
    let phone = #""p":{"ID":"nPhone","HostName":"iPhone","DNSName":"iphone.tail.test.","OS":"iOS","Online":true}"#
    let off = #""o":{"ID":"nOld","HostName":"Old","DNSName":"old.tail.test.","OS":"macOS","Online":false}"#
    let on = #""m":{"ID":"nMini","HostName":"Mini","DNSName":"mini.tail.test.","OS":"macOS","Online":true}"#
    for (peers, expected) in [
      ("", AddMachineModel.MacList.empty), (phone, .empty), (off, .offlineOnly), ("\(off),\(phone)", .offlineOnly),
      ("\(off),\(on)", .available),
    ] {
      harness.peers = peers
      await model.refreshPeers()
      XCTAssertEqual(model.macList, expected, peers)
    }
  }

  @MainActor func testAMachineAlreadyInRemoteMachinesShowsItsDoctorStateAndIsNotASetupTarget() async throws {
    let harness = Harness()
    harness.grantReady = true
    harness.builds = ["mini"]
    harness.peers =
      #""m":{"ID":"nMini","HostName":"Mini","DNSName":"mini.tail.test.","OS":"macOS","Online":false},"#
      + #""o":{"ID":"nOther","HostName":"Other","DNSName":"other.tail.test.","OS":"macOS","Online":true}"#
    let machines = harness.machinesModel()
    await machines.refresh(checkout: "/fixture")
    let model = harness.make(machines: machines)
    await model.refreshPeers()
    let mini = try XCTUnwrap(model.peers.first { $0.id == "nMini" })
    let other = try XCTUnwrap(model.peers.first { $0.id == "nOther" })

    XCTAssertFalse(mini.online)
    XCTAssertEqual(model.added(mini)?.status?.title, "Approved")
    XCTAssertNil(model.added(other))

    model.choose(other)
    XCTAssertEqual(model.selectedId, "nOther")
    model.choose(mini)
    XCTAssertEqual(model.selectedId, "nOther")
    XCTAssertEqual(model.existingPeer?.id, "nMini")
    model.choose(other)
    XCTAssertNil(model.existingPeer)
  }

  @MainActor func testMacListIgnoresAddedMachinesAndOnlyNamesMachinesThatCanStillBeAdded() async {
    let harness = Harness()
    harness.builds = ["mini"]
    let off = #""o":{"ID":"nOld","HostName":"Old","DNSName":"old.tail.test.","OS":"macOS","Online":false}"#
    let mini = #""m":{"ID":"nMini","HostName":"Mini","DNSName":"mini.tail.test.","OS":"macOS","Online":true}"#
    let machines = harness.machinesModel()
    await machines.refresh(checkout: "/fixture")
    let model = harness.make(machines: machines)
    for (peers, expected) in [(mini, AddMachineModel.MacList.empty), ("\(off),\(mini)", .offlineOnly)] {
      harness.peers = peers
      await model.refreshPeers()
      XCTAssertEqual(model.macList, expected, peers)
    }
  }

  @MainActor func testDiscoveryNeverPreselectsAMachineAlreadyInRemoteMachines() async {
    let harness = Harness()
    harness.builds = ["mini"]
    let machines = harness.machinesModel()
    await machines.refresh(checkout: "/fixture")
    let model = harness.make(machines: machines)
    model.preselect(machineID: "nMini", hostedSimulators: false)
    await model.refreshPeers()
    XCTAssertNil(model.selectedId)
  }

  @MainActor func testDiscoveryPreselectionWaitsForPeersAndRequiresTheUserToPick() async {
    let harness = Harness()
    let model = harness.make()
    model.preselect(machineID: "nMini", hostedSimulators: true)
    XCTAssertNil(model.selectedId)
    await model.refreshPeers()
    XCTAssertEqual(model.selectedId, "nMini")
    XCTAssertEqual(model.wizard.phase, .pick)
    XCTAssertTrue(harness.writes.isEmpty)
    await model.pick()
    XCTAssertEqual(model.wizard.phase, .choose)
    XCTAssertEqual(model.wizard.capabilities, [.deviceHost])
    XCTAssertTrue(harness.writes.isEmpty)
  }

  @MainActor func testDiscoveryPreselectionPreservesTheUsersPeerAndDefaultCapabilities() async {
    let harness = Harness()
    let model = harness.make()
    model.preselect(machineID: "nMini", hostedSimulators: false)
    model.selectedId = "user-choice"
    await model.refreshPeers()
    XCTAssertEqual(model.selectedId, "user-choice")
    model.selectedId = "nMini"
    await model.pick()
    XCTAssertEqual(model.wizard.capabilities, [.build, .deviceHost])
  }

  @MainActor func testNextReachesTheCommandWhileTheLocalServerRefusesForAFullConnection() async throws {
    let harness = Harness()
    let server = FullConnectionServer(
      settings: try JSONSerialization.data(withJSONObject: [
        "files": [:], "unknown": [], "settings": [["key": "remote.machines", "value": [], "layers": [:]]],
      ]))
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/add-machine-test.sock"), clientName: "test", clientVersion: "1",
      transport: { _, onEvent in
        server.onEvent = onEvent
        return server
      })
    client.start()
    defer { client.stop() }
    await waitUntil { client.isOpen }
    let home = "/tmp/add-machine-home"
    let cli = Task { StimCLI(environment: ["PATH": "/nonexistent", "STIM_HOME": home]) }
    let reader = MachineAccessReader(cli: cli) { (client, home) }
    harness.readServer = (
      doctor: { try await reader.report(cwd: $0, ask: false) },
      settings: { try await readServerSettings(cli: await cli.value, connection: (client, home), cwd: "/tmp") }
    )
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    server.refuseNext = 1
    await model.pick()
    XCTAssertNil(model.error)
    server.refuseNext = 2
    await model.next()
    XCTAssertNil(model.error)
    XCTAssertEqual(model.wizard.phase, .command)
  }

  @MainActor func testRequestsFollowSettingsAndTicketEnvironmentDoesNotLeakIntoPollOrCancel() async throws {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    XCTAssertTrue(harness.writes.isEmpty)
    await model.refresh()
    XCTAssertEqual(harness.builds, ["mini:7447"])
    XCTAssertEqual(harness.hosts, ["mini:7447"])
    XCTAssertEqual(harness.mode, "off")
    let askIndex = try XCTUnwrap(harness.steps.firstIndex(of: "ask"))
    XCTAssertLessThan(try XCTUnwrap(harness.steps.firstIndex(of: "remote.machines")), askIndex)
    XCTAssertNotNil(harness.asks.first(where: { $0.0 })?.1)
    XCTAssertNil(harness.asks.last?.1)
    await model.send(.cancel)
    XCTAssertTrue(harness.builds.isEmpty)
    XCTAssertTrue(harness.hosts.isEmpty)
    XCTAssertNil(harness.mode)
    XCTAssertEqual(harness.asks.last?.0, true)
    XCTAssertNil(harness.asks.last?.1)
  }

  @MainActor func testWizardSendsTheRequestsAndMovesToToolsWithoutAnotherNextPress() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.refresh()
    XCTAssertEqual(harness.builds, ["mini:7447"])
    XCTAssertNotNil(harness.asks.first(where: { $0.0 })?.1, "the ticket's request went out with no further action")
    harness.grantReady = true
    await checkUntilApproved(model)
    XCTAssertEqual(model.page, .setup, "approved, but the machine is still finishing setup")
    harness.journalDone = true
    await model.refresh()
    XCTAssertEqual(model.page, .tools)
    XCTAssertEqual(model.wizard.phase, .approved)
  }

  @MainActor func testRequestGoesOutAtOnceWhenTheMachineStartsWaitingForThisMac() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.refresh()
    let asked = { harness.asks.filter { $0.0 && $0.1 != nil }.count }
    let before = asked()
    harness.journalSteps = [
      .init(
        id: "approve", state: .running, title: "Access approval",
        detail: "Waiting for the requesting machine to connect. Stim Desktop sends this automatically.")
    ]
    await model.refresh()
    XCTAssertEqual(asked(), before + 1)
    await model.refresh()
    XCTAssertEqual(asked(), before + 1, "one request per signal, not one per poll")
  }

  @MainActor func testALapsedRequestIsAskedAgainFromAPollReadWithoutHangingTheWizard() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.refresh()
    let asks = { harness.asks.filter { $0.0 && $0.1 != nil }.count }
    let before = asks()
    harness.statusState = "lapsed"
    harness.now = harness.now.addingTimeInterval(31)
    var finished = false
    Task {
      await model.refresh()
      finished = true
    }
    await waitUntil { finished }
    XCTAssertTrue(finished, "the re-ask a poll read triggers must not wait for that read to end")
    XCTAssertGreaterThan(asks(), before)
    XCTAssertFalse(model.busy)
  }

  @MainActor func testADoctorRunNeverOverlapsAnotherOne() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.refresh()
    harness.doctorDelay = .milliseconds(300)
    async let poll: Void = model.refresh()
    try? await Task.sleep(for: .milliseconds(100))
    await model.send(.cancel)
    await poll
    XCTAssertEqual(harness.doctorMaxInFlight, 1, "a button press during a poll read waits for it")
  }

  @MainActor func testExpiredTicketSendsNoMoreRequestsAndAsksForANewCommand() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.refresh()
    harness.now = harness.now.addingTimeInterval(31 * 60)
    await model.refresh()
    XCTAssertEqual(model.wizard.phase, .expiredCommand)
    XCTAssertEqual(model.wizard.failure(now: harness.now), .expired)
    let asks = harness.asks.filter { $0.0 }.count
    await model.refresh()
    await model.refresh()
    XCTAssertEqual(harness.asks.filter { $0.0 }.count, asks, "no request is sent after the ticket expired")
  }

  @MainActor func testBackgroundPollReadsDoctorDuringSetupBesideTheJournal() async throws {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await waitUntil { model.wizard.entriesWritten }
    let reads = { harness.steps.filter { $0 == "readDoctor" }.count }
    let before = reads()
    for _ in 0..<6 {
      harness.now = harness.now.addingTimeInterval(1)
      try await Task.sleep(for: .milliseconds(1100))
    }
    XCTAssertGreaterThan(reads(), before, "the poll must read doctor every 5 seconds while it reads the journal every second")
  }

  @MainActor func testBackFromCapabilitiesReturnsToPickingAMac() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    XCTAssertFalse(model.canGoBack, "nothing precedes picking a Mac")
    model.selectedId = "nMini"
    await model.pick()
    XCTAssertEqual(model.wizard.phase, .choose)
    XCTAssertTrue(model.canGoBack)
    model.goBack()
    XCTAssertEqual(model.wizard.phase, .pick)
    XCTAssertNil(model.wizard.mac)
    XCTAssertNil(model.wizard.build)
    await model.pick()
    XCTAssertEqual(model.wizard.phase, .choose)
  }

  @MainActor func testBackFromAnUnrunCommandDropsItsTicketAndIssuesANewOne() async throws {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    let shown = try XCTUnwrap(model.command)
    let shownTicket = try XCTUnwrap(model.wizard.ticket)
    XCTAssertEqual(model.wizard.phase, .command)
    XCTAssertTrue(model.canGoBack)
    model.goBack()
    XCTAssertEqual(model.wizard.phase, .choose)
    XCTAssertNil(model.wizard.ticket)
    XCTAssertNotEqual(model.draftTicket, shownTicket)
    model.setCapability(.deviceHost, enabled: false)
    await model.next()
    XCTAssertNotEqual(model.wizard.ticket, shownTicket)
    XCTAssertNotEqual(model.command, shown)
    XCTAssertFalse(try XCTUnwrap(model.command).contains("--device-host"))
    XCTAssertTrue(harness.writes.isEmpty)
  }

  @MainActor func testBackFromAnExpiredUnrunCommandReturnsToCapabilities() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    harness.now = harness.now.addingTimeInterval(1801)
    await model.send(.tick)
    XCTAssertEqual(model.wizard.phase, .expiredCommand)
    XCTAssertTrue(model.canGoBack)
    model.goBack()
    XCTAssertEqual(model.wizard.phase, .choose)
    XCTAssertNil(model.wizard.ticket)
  }

  @MainActor func testBackIsRefusedOnceSetupStartedOrFinished() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await waitUntil { model.wizard.journal != nil }
    XCTAssertEqual(model.wizard.phase, .running)
    XCTAssertFalse(model.canGoBack)
    model.goBack()
    XCTAssertEqual(model.wizard.phase, .running)
    XCTAssertNotNil(model.wizard.ticket)
    harness.grantReady = true
    await checkUntilApproved(model)
    XCTAssertFalse(model.canGoBack)
    await model.openTools()
    XCTAssertFalse(model.canGoBack, "Tools")
    await model.openSummary()
    XCTAssertFalse(model.canGoBack, "Done")
  }

  @MainActor func testDoneKeepsASimulatorTargetTheWizardDoesNotOffer() async {
    let harness = Harness()
    harness.remotes = ["ios.remote": "eas", "android.remote": "eas"]
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.refresh()
    harness.grantReady = true
    await checkUntilApproved(model)
    await model.openSummary()
    XCTAssertNil(model.simulators)
    await model.finish()
    XCTAssertFalse(harness.writes.contains { $0.0.hasSuffix(".remote") })
    XCTAssertEqual(harness.remotes, ["ios.remote": "eas", "android.remote": "eas"])
  }

  @MainActor func testLeavingAfterSetupWithoutDoneRestoresTheBuildMode() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.refresh()
    harness.grantReady = true
    await checkUntilApproved(model)
    await model.openTools()
    XCTAssertEqual(harness.mode, "off")
    model.stop()
    await waitUntil { harness.mode == nil }
    XCTAssertNil(harness.mode)
  }

  @MainActor func testLeavingAfterDoneKeepsTheChosenBuildMode() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.refresh()
    harness.grantReady = true
    await checkUntilApproved(model)
    await model.openSummary()
    model.mode = .off
    await model.finish()
    model.stop()
    try? await Task.sleep(for: .milliseconds(100))
    XCTAssertEqual(harness.mode, "off")
  }

  @MainActor func testSetupDefaultsToAutoWithoutATestAndOnlyDoneWritesTheChoices() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.refresh()
    harness.grantReady = true
    await checkUntilApproved(model)
    XCTAssertEqual(model.wizard.phase, .approved)
    XCTAssertEqual(harness.mode, "off")
    await model.openSummary()
    XCTAssertEqual(model.mode, .auto)
    XCTAssertEqual(model.simulators, .auto)
    XCTAssertEqual(model.testOutcome, .notRun)
    XCTAssertEqual(harness.mode, "off")
    XCTAssertTrue(harness.remotes.isEmpty)
    model.simulators = .always
    await model.finish()
    XCTAssertEqual(harness.mode, "auto")
    XCTAssertEqual(harness.remotes, ["ios.remote": "mini:7447", "android.remote": "mini:7447"])
    XCTAssertEqual(harness.builds, ["mini:7447"])
    XCTAssertEqual(harness.hosts, ["mini:7447"])
    XCTAssertNil(model.error)
  }

  @MainActor func testRequestFailureRemainsVisibleAfterTheSettingsEffectsFinish() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    harness.shouldFailDoctor = true
    let journal = SetupJournal(ticket: model.wizard.ticket!, capabilities: [.build, .deviceHost], steps: [])
    await model.send(.journalAnswered(port: 7447, journal: journal))
    XCTAssertNotNil(model.error)
    XCTAssertTrue(model.wizard.entriesWritten)
    XCTAssertEqual(harness.builds, ["mini:7447"])
  }

  @MainActor func testNoWorkspaceSendsNothingAndAJournalForAnotherTicketIsIgnored() async {
    let harness = Harness()
    let blocked = harness.make(workspace: false)
    await blocked.start()
    defer { blocked.stop() }
    blocked.selectedId = "nMini"
    await blocked.pick()
    await blocked.next()
    XCTAssertTrue(blocked.command?.contains("--build") == true)
    XCTAssertTrue(blocked.command?.contains("--device-host") == true)
    await blocked.refresh()
    XCTAssertEqual(blocked.wizard.failure(now: harness.now), .noWorkspace)
    XCTAssertTrue(harness.writes.isEmpty)
    XCTAssertTrue(harness.asks.isEmpty)
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    harness.journalExpiryOffset = 60
    await model.refresh()
    XCTAssertNil(model.wizard.journal)
    XCTAssertTrue(harness.writes.isEmpty)
    harness.journalExpiryOffset = 0
    harness.peerId = "replacement"
    await model.refresh()
    XCTAssertNil(model.wizard.journal)
    XCTAssertTrue(harness.writes.isEmpty)
  }

  @MainActor func testFailedEntryWriteLeavesOtherMachinesUntouched() async {
    let harness = Harness()
    harness.builds = ["existing"]
    harness.mode = "auto"
    harness.modeOrigin = "machine"
    harness.shouldFailHostWrite = true
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.refresh()
    XCTAssertNotNil(model.error)
    XCTAssertEqual(harness.builds, ["existing"])
    await model.send(.cancel)
    XCTAssertEqual(harness.builds, ["existing"])
    XCTAssertEqual(harness.mode, "auto")
    XCTAssertFalse(harness.writes.contains { $0.0 == "remote.buildMode" })
  }
  @MainActor func testReadySampleSuppliesCheckoutWhenNoWorkspaceIsListed() async {
    let harness = Harness()
    let location = WizardSample(applicationSupport: URL(fileURLWithPath: "/fixture"))
    let sample = SampleBuildModel(
      dependencies: .init(
        sample: location,
        timings: { _ in BuildTimings(offerMs: 1, syncMs: 1, workerMs: 1, fetchMs: 1, totalMs: 4) },
        run: { _, _ in
          WizardCommandOutput(exit: 0, stdout: Data(), stderr: "")
        }, exists: { $0 == location.marker }))
    sample.prepare()
    await waitUntil { sample.sampleReady }
    let model = harness.make(workspace: false, sample: sample)
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.refresh()
    harness.grantReady = true
    await checkUntilApproved(model)
    XCTAssertEqual(model.wizard.phase, .approved)
    XCTAssertTrue(harness.doctorPaths.allSatisfy { $0 == location.folder.path })
    XCTAssertEqual(harness.builds, ["mini:7447"])
    await model.send(.cancel)
    XCTAssertTrue(harness.builds.isEmpty)
    XCTAssertNil(harness.mode)
  }

  @MainActor func testSampleLearnsExistingApprovalsBeforeIssuingSetupCommand() async throws {
    let harness = Harness()
    harness.builds = ["mini"]
    harness.hosts = ["mini"]
    harness.grantReady = true
    let location = WizardSample(applicationSupport: URL(fileURLWithPath: "/fixture"))
    let sample = SampleBuildModel(
      dependencies: .init(
        sample: location,
        timings: { _ in BuildTimings(offerMs: 1, syncMs: 1, workerMs: 1, fetchMs: 1, totalMs: 4) },
        run: { _, _ in WizardCommandOutput(exit: 0, stdout: Data(), stderr: "") },
        exists: { $0 == location.marker }))
    let model = harness.make(workspace: false, sample: sample)
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    XCTAssertTrue(sample.preparing || sample.sampleReady, "Picking a Mac must start preparing the sample without waiting")
    XCTAssertNil(model.command, "The sample path must learn approvals before exposing a setup command")
    await model.next()
    let command = try XCTUnwrap(model.command)
    XCTAssertFalse(command.contains("--build"), "Setup must not request an existing build approval")
    XCTAssertFalse(command.contains("--device-host"), "Setup must not request an existing device-host approval")
    XCTAssertEqual(model.wizard.phase, .approved, "Existing approvals must skip waiting for a new grant")
    XCTAssertEqual(model.page, .tools)
    XCTAssertEqual(harness.doctorPaths, [location.folder.path])
    XCTAssertTrue(harness.asks.allSatisfy { !$0.0 && $0.1 == nil })
    XCTAssertTrue(model.wizard.revokeIds.isEmpty)
  }

  @MainActor func testExistingApprovalOnANonDefaultPortIsLearnedBeforeTheSetupCommand() async throws {
    let harness = Harness()
    harness.builds = ["mini:7444"]
    harness.hosts = ["mini:7444"]
    harness.grantReady = true
    let location = WizardSample(applicationSupport: URL(fileURLWithPath: "/fixture"))
    let sample = SampleBuildModel(
      dependencies: .init(
        sample: location,
        timings: { _ in BuildTimings(offerMs: 1, syncMs: 1, workerMs: 1, fetchMs: 1, totalMs: 4) },
        run: { _, _ in WizardCommandOutput(exit: 0, stdout: Data(), stderr: "") },
        exists: { $0 == location.marker }))
    let model = harness.make(workspace: false, sample: sample)
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    let command = try XCTUnwrap(model.command)
    XCTAssertFalse(command.contains("--build"))
    XCTAssertFalse(command.contains("--device-host"))
    XCTAssertEqual(model.wizard.phase, .approved)
  }

  @MainActor func testSamplePreparationKeepsNextBusyAndFailureDoesNotIssueACommand() async {
    let harness = Harness()
    harness.builds = ["mini"]
    harness.hosts = ["mini"]
    harness.grantReady = true
    let location = WizardSample(applicationSupport: URL(fileURLWithPath: "/fixture"))
    var preparation: CheckedContinuation<WizardCommandOutput, Never>?
    var markerExists = false
    let sample = SampleBuildModel(
      dependencies: .init(
        sample: location,
        timings: { _ in BuildTimings(offerMs: 1, syncMs: 1, workerMs: 1, fetchMs: 1, totalMs: 4) },
        run: { _, _ in await withCheckedContinuation { preparation = $0 } },
        exists: { $0 == location.marker && markerExists }, create: { _ in }))
    let model = harness.make(workspace: false, sample: sample)
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    let next = Task { await model.next() }
    await waitUntil { preparation != nil }
    XCTAssertTrue(model.busy, "Next must remain busy while sample preparation is pending")
    preparation?.resume(returning: WizardCommandOutput(exit: 1, stdout: Data(), stderr: "Sample unavailable"))
    await next.value
    await waitUntil { !sample.preparing }
    XCTAssertFalse(model.busy)
    XCTAssertEqual(model.wizard.failure(now: harness.now), .noWorkspace)
    XCTAssertNil(model.command, "Failed sample preparation must not expose an unchecked setup command")
    XCTAssertTrue(harness.asks.isEmpty)
    XCTAssertTrue(harness.writes.isEmpty)
    guard case .failed(_, let message, _) = sample.test.state else { return XCTFail("Sample failure must remain retryable") }
    XCTAssertTrue(message.contains("Sample unavailable"))
    markerExists = true
    sample.prepare()
    await model.next()
    XCTAssertEqual(model.wizard.phase, .approved)
    XCTAssertFalse(model.command?.contains("--build") == true)
    XCTAssertFalse(model.command?.contains("--device-host") == true)
  }

  @MainActor func testCancelAfterTheTestAtStepsFiveAndSixRestoresSettingsAndStopsTheSample() async {
    for summary in [false, true] {
      let harness = Harness()
      let location = WizardSample(applicationSupport: URL(fileURLWithPath: "/fixture"))
      var stops = 0
      let sample = SampleBuildModel(
        dependencies: .init(
          sample: location,
          timings: { _ in BuildTimings(offerMs: 1, syncMs: 1, workerMs: 1, fetchMs: 1, totalMs: 4) },
          run: { command, _ in
            var stdout = ""
            switch command.arguments.first {
            case "ios":
              stdout =
                command.arguments.contains("local")
                ? "{\"launched\":true}" : "{\"offloadedTo\":\"mini:7447\",\"launched\":true}"
            case "stop": stops += 1
            default: break
            }
            return WizardCommandOutput(exit: 0, stdout: Data(stdout.utf8), stderr: "")
          }, exists: { $0 == location.marker }))
      let model = harness.make(sample: sample)
      await model.start()
      defer { model.stop() }
      model.selectedId = "nMini"
      await model.pick()
      await model.next()
      await model.refresh()
      harness.grantReady = true
      await checkUntilApproved(model)
      await model.openTools()
      await waitUntil { sample.sampleReady }
      model.openTest()
      await waitUntil { sample.test.passed && !sample.running }
      XCTAssertTrue(sample.test.passed)
      XCTAssertEqual(model.page, .test)
      XCTAssertEqual(harness.mode, "off")
      if summary { await model.openSummary() }
      let stopsBeforeCancel = stops
      await model.send(.cancel)
      XCTAssertGreaterThan(stops, stopsBeforeCancel)
      XCTAssertFalse(sample.running)
      XCTAssertTrue(harness.builds.isEmpty)
      XCTAssertTrue(harness.hosts.isEmpty)
      XCTAssertNil(harness.mode)
      XCTAssertEqual(model.wizard.phase, .cancelled)
    }
  }

  @MainActor func testSetupAddsTheEntryOnceAndKeepsOtherMachines() async {
    for alreadyListed in [false, true] {
      for buildsChosen in [false, true] {
        let harness = Harness()
        harness.builds = alreadyListed ? ["mini"] : ["other"]
        harness.grantReady = alreadyListed
        let model = harness.make()
        await model.start()
        defer { model.stop() }
        model.selectedId = "nMini"
        await model.pick()
        if !buildsChosen { model.setCapability(.build, enabled: false) }
        await model.next()
        if !alreadyListed {
          await model.refresh()
          harness.grantReady = true
          await checkUntilApproved(model)
        }
        await model.openSummary()
        XCTAssertEqual(harness.builds, alreadyListed ? ["mini"] : ["other", "mini:7447"])
      }
    }
  }

  @MainActor func testHostedOnlySetupReportsBuildTestNotRunAfterSkip() async {
    let harness = Harness()
    let sample = SampleBuildModel(
      dependencies: .init(
        sample: WizardSample(applicationSupport: URL(fileURLWithPath: "/fixture")),
        timings: { _ in BuildTimings(offerMs: 1, syncMs: 1, workerMs: 1, fetchMs: 1, totalMs: 4) },
        run: { _, _ in WizardCommandOutput(exit: 0, stdout: Data(), stderr: "") }))
    sample.fixture([.prepared, .skip])
    let model = harness.make(sample: sample)
    await model.refreshPeers()
    model.selectedId = "nMini"
    await model.pick()
    XCTAssertEqual(model.testOutcome, .skipped)
    model.setCapability(.build, enabled: false)
    XCTAssertEqual(model.testOutcome, .notRun)
  }

  @MainActor func testAndroidFailuresNeverBlockTheIosTest() async {
    let harness = Harness()
    harness.builds = ["mini"]
    harness.hosts = ["mini"]
    harness.grantReady = true
    harness.toolProblems["android"] = [
      ["code": "jdk", "reason": "JDK 17 there, none here"],
      ["code": "android-sdk", "reason": "no Android SDK there"],
      ["code": "ndk", "reason": "no NDK there"],
      ["code": "build-tools", "reason": "no build-tools there"],
      ["code": "compile-sdk", "reason": "no platform there"],
      ["code": "stim-build", "reason": "Android-only comparison failure"],
    ]
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    XCTAssertTrue(harness.toolCalls.contains("android"), "Builds covers Android, so its tools are checked without asking")
    XCTAssertNotNil(model.tools.first { $0.id == "jdk" }?.state.fix)
    XCTAssertFalse(model.tools.contains { $0.detail?.contains("Android builds off") == true })
    XCTAssertFalse(model.tools.contains { $0.blocks })
    await model.openSummary()
    XCTAssertEqual(model.page, .summary)
  }

  @MainActor func testOffersNoCommandWhileThisMacsServerPredatesTheTicketVariable() async {
    for old in ["1.20.2", "1.20.3"] {
      let harness = Harness()
      harness.peers = #""one":{"ID":"nMini","HostName":"Mini","DNSName":"mini.tail.test.","OS":"macOS","Online":true}"#
      harness.version = old
      let model = harness.make()
      await model.start()
      model.preselect(machineID: "nMini", hostedSimulators: true)
      await model.pick()
      XCTAssertEqual(model.serverTooOldForSetup, old)
      XCTAssertNil(model.command)
      model.stop()
    }
  }

  @MainActor func testFlagsAChosenMachineWhoseServerPredatesProtocolTwo() async throws {
    for (remote, expected) in [("1.20.2", "1.20.2"), ("1.20.3", "1.20.3"), ("1.21.0-rc.1", "1.21.0-rc.1"), ("1.21.0", nil)] {
      let harness = Harness()
      harness.health = try JSONDecoder().decode(
        Tailnet.Health.self, from: Data(#"{"server":"stim-server","version":"\#(remote)"}"#.utf8))
      let model = harness.make()
      await model.start()
      model.preselect(machineID: "nMini", hostedSimulators: false)
      await model.pick()
      XCTAssertEqual(model.olderThanSetup, expected)
      model.stop()
    }
  }

  @MainActor func testLinuxAndWindowsMachinesSetUpBuildsOnlyAndCheckAndroidToolsOnly() async {
    for (os, prefix) in [
      ("linux", "sudo tailscale set --operator=$USER && \\\n"), ("windows", "& { $env:STIM_SETUP_TICKET='"),
    ] {
      await checkAndroidOnly(os: os, commandPrefix: prefix)
    }
  }

  @MainActor private func checkAndroidOnly(os: String, commandPrefix: String) async {
    let harness = Harness()
    harness.peers = #""one":{"ID":"nMini","HostName":"Mini","DNSName":"mini.tail.test.","OS":"\#(os)","Online":true}"#
    harness.builds = ["mini"]
    harness.grantReady = true
    harness.toolProblems["android"] = [["code": "jdk", "reason": "JDK none there, 17 here"]]
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.preselect(machineID: "nMini", hostedSimulators: true)
    await model.pick()
    XCTAssertEqual(model.wizard.capabilities, [.build])
    XCTAssertTrue(model.command?.hasPrefix(commandPrefix) == true, os)
    XCTAssertFalse(model.command?.contains("--device-host") == true)
    await model.next()
    await checkUntilApproved(model)
    await model.openTools()
    XCTAssertEqual(Set(harness.toolCalls), ["android"])
    XCTAssertFalse(model.tools.contains { ["xcode", "runtime", "cocoapods"].contains($0.id) })
    XCTAssertTrue(model.tools.contains { $0.blocks }, "a \(os) machine without a JDK cannot take any build")
    await model.openSummary()
    XCTAssertEqual(model.page, .summary, "a red tool row never stops the wizard")
    await model.finish()
    XCTAssertTrue(model.finished)
    XCTAssertEqual(harness.builds, ["mini"], "the machine stays added")
    XCTAssertEqual(model.testPlatform, "android")
  }

  @MainActor func testToolsRefreshByThemselvesTenSecondsAfterTheLastCheck() async throws {
    let harness = Harness()
    harness.builds = ["mini"]
    harness.hosts = ["mini"]
    harness.grantReady = true
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    let ios = { harness.toolCalls.filter { $0 == "ios" }.count }
    XCTAssertEqual(ios(), 1)
    harness.now = harness.now.addingTimeInterval(9)
    try await Task.sleep(for: .milliseconds(1100))
    XCTAssertEqual(ios(), 1)
    harness.now = harness.now.addingTimeInterval(1)
    try await Task.sleep(for: .milliseconds(1100))
    XCTAssertEqual(ios(), 2)
  }

}

@MainActor func waitUntil(_ condition: @MainActor () -> Bool) async {
  for _ in 0..<2000 {
    if condition() { return }
    try? await Task.sleep(for: .milliseconds(10))
  }
}

@MainActor func checkUntilApproved(_ model: AddMachineModel) async {
  for _ in 0..<500 {
    await model.refresh()
    if model.wizard.phase == .approved { return }
    try? await Task.sleep(for: .milliseconds(10))
  }
}

@MainActor private final class FullConnectionServer: ServerTransport {
  var onEvent: (@MainActor (ServerTransportEvent) -> Void)?
  var refuseNext = 0
  private let settings: Data

  init(settings: Data) { self.settings = settings }

  func close() {}

  func send(_ text: String) {
    guard case .object(let request)? = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)),
      let id = request["id"], case .string(let method)? = request["method"]
    else { return }
    if method != "hello", method != "desktop.reports.invalidate", refuseNext > 0 {
      refuseNext -= 1
      return answer([
        "id": id,
        "error": .object([
          "code": .string("limit-exceeded"), "message": .string("A connection can run 4 requests at a time."),
        ]),
      ])
    }
    switch method {
    case "hello":
      answer([
        "id": id,
        "result": .object([
          "protocol": .number(1),
          "server": .object([
            "id": .string("home"), "name": .string("Mac"), "version": .string("1"), "stim": .string("1"),
          ]),
          "capabilities": .array([.string("read")]),
          "features": .array([.string("desktop-reports"), .string("desktop-settings")]),
        ]),
      ])
    case "desktop.reports.get":
      answer([
        "id": id,
        "result": .object([
          "pending": .bool(false),
          "value": .object([
            "project": .string("/fixture"), "findings": .array([]), "remoteMachines": .array([]),
            "deviceHosts": .array([]),
          ]),
        ]),
      ])
    case "desktop.settings.get":
      answer(["id": id, "result": (try? JSONDecoder().decode(JSONValue.self, from: settings)) ?? .null])
    default:
      answer(["id": id, "result": .object([:])])
    }
  }

  private func answer(_ message: [String: JSONValue]) {
    guard let data = try? JSONEncoder().encode(JSONValue.object(message)) else { return }
    onEvent?(.text(String(decoding: data, as: UTF8.self)))
  }
}
