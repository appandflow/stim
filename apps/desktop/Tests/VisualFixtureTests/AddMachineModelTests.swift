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
    var hosts: [String] = []
    var mode: String?
    var modeOrigin: String? = "default"
    var grantReady = false
    var journalNode = "nSelf"
    var peerId = "nMini"
    var shouldFailHostWrite = false
    var shouldFailDoctor = false
    var toolProblems: [String: [[String: String]]] = [:]
    var toolCalls: [String] = []

    var status: Data {
      Data(
        """
        {"BackendState":"Running","Self":{"ID":"nSelf","HostName":"Laptop","DNSName":"laptop.tail.test."},
         "Peer":{"one":{"ID":"\(peerId)","HostName":"Mini","DNSName":"mini.tail.test.","OS":"macOS","Online":true}}}
        """.utf8)
    }
    func payload() throws -> SettingsPayload {
      let object: [String: Any] = [
        "files": [:], "unknown": [],
        "settings": [
          ["key": "offload.machines", "value": builds, "layers": [:]],
          ["key": "hosting.machines", "value": hosts, "layers": [:]],
          ["key": "offload.mode", "value": mode ?? "auto", "origin": modeOrigin ?? "default", "layers": [:]],
        ],
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
          "project": "/fixture", "findings": [], "buildMachines": statuses(builds, id: "b"),
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
            if key == "hosting.machines", self.shouldFailHostWrite { throw Failure.refused }
            self.writes.append((key, value))
            self.steps.append(key)
            switch key {
            case "offload.mode": self.mode = value
            case "offload.machines":
              self.builds = try value.map { try JSONDecoder().decode([String].self, from: Data($0.utf8)) } ?? []
            case "hosting.machines":
              self.hosts = try value.map { try JSONDecoder().decode([String].self, from: Data($0.utf8)) } ?? []
            default: break
            }
          }, version: { "1.16.0" },
          toolsDoctor: { _, platform in
            self.toolCalls.append(platform)
            return try self.report(platform: platform)
          }, now: { self.now }, ticket: { SetupTicket.generate(now: $0) }), sample: sample)
    }
    private enum Failure: Error { case refused }
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
    await model.checkAgain()
    XCTAssertEqual(harness.builds, ["mini:7447"])
    XCTAssertEqual(harness.hosts, ["mini:7447"])
    XCTAssertEqual(harness.mode, "off")
    let askIndex = try XCTUnwrap(harness.steps.firstIndex(of: "ask"))
    XCTAssertLessThan(try XCTUnwrap(harness.steps.firstIndex(of: "offload.machines")), askIndex)
    XCTAssertLessThan(try XCTUnwrap(harness.steps.firstIndex(of: "hosting.machines")), askIndex)
    XCTAssertEqual(harness.asks.first(where: { $0.0 })?.1.keys.sorted(), ["STIM_ACCESS_TICKET"])
    XCTAssertEqual(harness.asks.last?.1, [:])
    await model.send(.cancel)
    XCTAssertTrue(harness.builds.isEmpty)
    XCTAssertTrue(harness.hosts.isEmpty)
    XCTAssertNil(harness.mode)
    XCTAssertEqual(harness.asks.last?.0, true)
    XCTAssertEqual(harness.asks.last?.1, [:])
  }

  @MainActor func testSkippedTestKeepsModeOffAndApprovedEntries() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.checkAgain()
    harness.grantReady = true
    await checkUntilApproved(model)
    XCTAssertEqual(model.wizard.phase, .approved)
    XCTAssertEqual(harness.mode, "off")
    await model.openSummary()
    XCTAssertEqual(model.mode, .off)
    await model.finish()
    XCTAssertEqual(harness.mode, "off")
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
    await blocked.checkAgain()
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
    await model.checkAgain()
    XCTAssertNil(model.wizard.journal)
    XCTAssertTrue(harness.writes.isEmpty)
    harness.journalNode = "nSelf"
    harness.peerId = "replacement"
    await model.checkAgain()
    XCTAssertNil(model.wizard.journal)
    XCTAssertTrue(harness.writes.isEmpty)
  }

  @MainActor func testCancelAfterPartialWriteRestoresWhatWasWrittenAndPreservesOtherMachines() async {
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
    await model.checkAgain()
    XCTAssertNotNil(model.error)
    XCTAssertEqual(harness.builds, ["existing", "mini:7447"])
    await model.send(.cancel)
    XCTAssertEqual(harness.builds, ["existing"])
    XCTAssertEqual(harness.mode, "auto")
    XCTAssertFalse(harness.writes.contains { $0.0 == "offload.mode" })
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
    await model.checkAgain()
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

  @MainActor func testPassedTestDefaultsToAutoButOnlyDoneWritesIt() async {
    let harness = Harness()
    let sample = SampleBuildModel(
      dependencies: .init(
        sample: WizardSample(applicationSupport: URL(fileURLWithPath: "/fixture")),
        run: { _, _ in
          WizardCommandOutput(exit: 0, stdout: Data(), stderr: "")
        }))
    sample.fixture([
      .prepared, .start, .offload(.success), .timings(.init(offerMs: 1, syncMs: 1, workerMs: 1, fetchMs: 1, totalMs: 4)),
      .localStart, .localFinished(passed: true, ms: 5),
    ])
    let model = harness.make(sample: sample)
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.checkAgain()
    harness.grantReady = true
    await checkUntilApproved(model)
    await model.openSummary()
    XCTAssertEqual(model.mode, .auto)
    XCTAssertEqual(harness.mode, "off")
    await model.finish()
    XCTAssertEqual(harness.mode, "auto")
    XCTAssertTrue(model.finished)
    XCTAssertEqual(harness.builds, ["mini:7447"])
    XCTAssertEqual(harness.hosts, ["mini:7447"])
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
      await model.checkAgain()
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

  @MainActor func testSummaryNamesOnlyEntriesAddedForChosenCapabilities() async {
    for alreadyListed in [false, true] {
      for buildsChosen in [false, true] {
        let harness = Harness()
        harness.builds = alreadyListed ? ["mini"] : ["other-build"]
        harness.hosts = alreadyListed ? ["mini"] : ["other-host"]
        harness.grantReady = alreadyListed
        let model = harness.make()
        await model.start()
        defer { model.stop() }
        model.selectedId = "nMini"
        await model.pick()
        if !buildsChosen { model.setCapability(.build, enabled: false) }
        await model.next()
        if !alreadyListed {
          await model.checkAgain()
          harness.grantReady = true
          await checkUntilApproved(model)
        }
        await model.openSummary()
        XCTAssertEqual(model.summary.contains { $0.contains("offload.machines") }, !alreadyListed && buildsChosen)
        XCTAssertEqual(model.summary.contains { $0.contains("hosting.machines") }, !alreadyListed)
        XCTAssertFalse(model.summary.contains { $0.contains("other-build") || $0.contains("other-host") })
        if !alreadyListed { XCTAssertTrue(model.summary.contains { $0.contains("mini:7447") }) }
      }
    }
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
    XCTAssertFalse(harness.toolCalls.contains("android"))
    await model.checkAndroid()
    XCTAssertTrue(harness.toolCalls.contains("android"))
    XCTAssertNotNil(model.tools.first { $0.id == "jdk" }?.state.fix)
    XCTAssertFalse(model.toolsBlock)
    model.openTest()
    XCTAssertEqual(model.page, .test)
  }

  @MainActor func testAutomaticToolsChecksWaitThirtySecondsAfterEntryAndManualCheck() async throws {
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
    XCTAssertEqual(harness.toolCalls, ["ios"])
    await model.checkAgain()
    XCTAssertEqual(harness.toolCalls, ["ios", "ios"])
    harness.now = harness.now.addingTimeInterval(29)
    try await Task.sleep(for: .milliseconds(1100))
    XCTAssertEqual(harness.toolCalls, ["ios", "ios"])
    harness.now = harness.now.addingTimeInterval(1)
    try await Task.sleep(for: .milliseconds(1100))
    XCTAssertEqual(harness.toolCalls, ["ios", "ios", "ios"])
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
    await model.checkAgain()
    if model.wizard.phase == .approved { return }
    try? await Task.sleep(for: .milliseconds(10))
  }
}
