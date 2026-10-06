import Foundation
import StimKit
import XCTest

@testable import StimDesktop

final class AddMachineModelTests: XCTestCase {
  @MainActor private final class Harness {
    let now = Date(timeIntervalSince1970: 1_791_284_400)
    var writes: [(String, String?)] = []
    var asks: [(Bool, [String: String])] = []
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
    func report() throws -> DoctorReport {
      func statuses(_ entries: [String], id: String) -> [[String: Any]] {
        entries.map {
          ["machine": $0, "state": grantReady ? "approved" : "pending", "deviceId": id, "dnsName": "mini.tail.test"]
        }
      }
      return try JSONDecoder().decode(
        DoctorReport.self,
        from: JSONSerialization.data(withJSONObject: [
          "project": "/fixture", "findings": [], "buildMachines": statuses(builds, id: "b"),
          "deviceHosts": statuses(hosts, id: "h"),
        ]))
    }
    func make(workspace: Bool = true) -> AddMachineModel {
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
          doctor: { _, ask, env in
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
          }, version: { "1.16.0" }, now: { self.now }, ticket: { SetupTicket.generate(now: $0) }))
    }
    private enum Failure: Error { case refused }
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

  @MainActor func testDoneKeepsModeOffWhileKeepingTheApprovedEntries() async {
    let harness = Harness()
    let model = harness.make()
    await model.start()
    defer { model.stop() }
    model.selectedId = "nMini"
    await model.pick()
    await model.next()
    await model.checkAgain()
    harness.grantReady = true
    await model.checkAgain()
    XCTAssertEqual(model.wizard.phase, .approved)
    XCTAssertEqual(harness.mode, "off")
    await model.send(.done)
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
}
