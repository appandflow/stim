import Foundation
import StimKit
import XCTest

@testable import StimDesktop

final class AddMachineModelTests: XCTestCase {
  @MainActor private final class Harness {
    var now = Date(timeIntervalSince1970: 1_791_284_400)
    var writes: [(String, String?)] = []
    var asks: [(Bool, [String: String])] = []
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
    var journalNode = "nSelf"
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
            "machine": $0, "state": grantReady ? "approved" : "pending", "deviceId": id, "dnsName": "mini.tail.test",
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
    func make(workspace: Bool = true, sample: SampleBuildModel? = nil) -> AddMachineModel {
      AddMachineModel(
        checkout: workspace ? "/fixture" : nil,
        dependencies: .init(
          status: { self.status }, health: { _, _ in nil },
          journal: { _, port, _ in
            guard port == 7447 else { return .notFound }
            return .journal(
              SetupJournal(
                nodeId: self.journalNode, ticket: SetupTicket.generate(now: self.now),
                capabilities: [.build, .deviceHost], steps: [],
                granted: self.grantReady ? [.init(capability: .build, id: "b"), .init(capability: .deviceHost, id: "h")] : []))
          },
          doctor: { cwd, ask, env in
            self.doctorPaths.append(cwd)
            self.asks.append((ask, env))
            self.steps.append(ask ? "ask" : "readDoctor")
            if self.shouldFailDoctor { throw Failure.refused }
            return try self.report()
          }, readSettings: { try self.payload() },
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
          }, version: { "1.16.0" },
          toolsDoctor: { _, platform in
            self.toolCalls.append(platform)
            return try self.report(platform: platform)
          }, now: { self.now },
          ticket: { SetupTicket.generate(now: $0) }), sample: sample)
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
    XCTAssertEqual(harness.asks.first(where: { $0.0 })?.1.keys.sorted(), ["STIM_ACCESS_TICKET"])
    XCTAssertEqual(harness.asks.last?.1, [:])
    await model.send(.cancel)
    XCTAssertTrue(harness.builds.isEmpty)
    XCTAssertTrue(harness.hosts.isEmpty)
    XCTAssertNil(harness.mode)
    XCTAssertEqual(harness.asks.last?.0, true)
    XCTAssertEqual(harness.asks.last?.1, [:])
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
    let journal = SetupJournal(nodeId: "nSelf", ticket: model.wizard.ticket!, capabilities: [.build, .deviceHost], steps: [])
    await model.send(.journalAnswered(port: 7447, journal: journal))
    XCTAssertNotNil(model.error)
    XCTAssertTrue(model.wizard.entriesWritten)
    XCTAssertEqual(harness.builds, ["mini:7447"])
  }

  @MainActor func testNoWorkspaceSendsNothingAndDifferentNodeJournalIsIgnored() async {
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
    harness.journalNode = "other-node"
    await model.refresh()
    XCTAssertNil(model.wizard.journal)
    XCTAssertTrue(harness.writes.isEmpty)
    harness.journalNode = "nSelf"
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
    XCTAssertTrue(harness.asks.allSatisfy { !$0.0 && $0.1.isEmpty })
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
          run: { command, _ in
            var stdout = ""
            switch command.arguments.first {
            case "ios":
              stdout =
                command.arguments.contains("local")
                ? "{\"launched\":true}" : "{\"offloadedTo\":\"mini:7447\",\"launched\":true}"
            case "logs":
              stdout =
                "{\"event\":\"offload_done\",\"timings\":{\"offerMs\":1,\"syncMs\":1,\"workerMs\":1,\"fetchMs\":1,\"totalMs\":4}}"
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
    XCTAssertFalse(model.toolsBlock)
    await model.openSummary()
    XCTAssertEqual(model.page, .summary)
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
