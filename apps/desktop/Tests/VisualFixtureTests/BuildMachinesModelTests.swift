import Foundation
import StimKit
import XCTest

@testable import StimDesktop

final class BuildMachinesModelTests: XCTestCase {
  @MainActor private final class Harness {
    var now = Date(timeIntervalSince1970: 1000)
    var calls: [(String, Bool)] = []
    var hosts: [String]? = ["mini"]
    var fails = false
    var waiting: CheckedContinuation<Void, Never>?
    var block = false
    var machines: String?

    nonisolated static func payload(_ machines: String) -> SettingsPayload {
      let entry = "{ \"key\": \"remote.machines\", \"value\": \(machines), \"origin\": \"machine\", \"layers\": {} }"
      return try! JSONDecoder().decode(
        SettingsPayload.self, from: Data("{ \"files\": {}, \"unknown\": [], \"settings\": [\(entry)] }".utf8))
    }

    func make() -> BuildMachinesModel {
      let cli = Task { StimCLI(environment: [:], override: "/usr/bin/false") }
      let settings = MachineSettingsStore(
        read: {
          guard let machines = await self.machines else { throw StimCLI.Failure.exited(1, stderr: "Unexpected settings read") }
          return Harness.payload(machines)
        },
        write: { _, value, _, _ in
          guard let value else { throw StimCLI.Failure.exited(1, stderr: "Unexpected settings write") }
          await MainActor.run { self.machines = value }
          return .written(Harness.payload(value).entry("remote.machines")!)
        })
      return BuildMachinesModel(
        cli: cli, settings: settings, statsReader: StatsReader(cli: cli, server: { nil }),
        now: { self.now },
        machineAccess: { checkout, ask in
          self.calls.append((checkout, ask))
          if self.block { await withCheckedContinuation { self.waiting = $0 } }
          if self.fails { throw StimCLI.Failure.exited(1, stderr: "Doctor failed") }
          var object: [String: Any] = ["project": checkout, "findings": [], "remoteMachines": []]
          if let hosts = self.hosts { object["deviceHosts"] = hosts.map { ["machine": $0, "state": "approved"] } }
          return try JSONDecoder().decode(DoctorReport.self, from: JSONSerialization.data(withJSONObject: object))
        })
    }
  }

  @MainActor func testUnknownHostsAndFailedDoctorKeepSavedMachineUntilAnAuthoritativeReport() async {
    let harness = Harness()
    let model = harness.make()
    XCTAssertNil(model.approvedHostingMachines(in: "/w"))
    harness.fails = true
    await model.refreshHostingMachines(checkout: "/w")
    XCTAssertNil(model.approvedHostingMachines(in: "/w"))
    harness.fails = false
    await model.refreshStatuses(checkout: "/w", ask: false)
    XCTAssertEqual(model.approvedHostingMachines(in: "/w"), ["mini"])
    harness.fails = true
    await model.refreshStatuses(checkout: "/w", ask: false)
    XCTAssertEqual(model.approvedHostingMachines(in: "/w"), ["mini"])
    XCTAssertNotNil(model.check(in: "/w")?.problem)
    harness.fails = false
    harness.hosts = []
    await model.refreshStatuses(checkout: "/w", ask: false)
    XCTAssertEqual(model.approvedHostingMachines(in: "/w"), [])
    harness.hosts = nil
    await model.refreshStatuses(checkout: "/w", ask: false)
    XCTAssertNil(model.approvedHostingMachines(in: "/w"))
  }

  @MainActor func testPickerRefreshesAreSharedPerWorkspaceAndWaitMoreThanFiveMinutesAfterCompletion() async {
    let harness = Harness()
    let model = harness.make()
    harness.block = true
    let first = Task { await model.refreshHostingMachines(checkout: "/w") }
    await waitUntil { harness.waiting != nil }
    await model.refreshHostingMachines(checkout: "/w")
    XCTAssertEqual(harness.calls.count, 1)
    harness.now = harness.now.addingTimeInterval(600)
    harness.block = false
    harness.waiting?.resume()
    await first.value
    await model.refreshHostingMachines(checkout: "/w")
    harness.now = harness.now.addingTimeInterval(300)
    await model.refreshHostingMachines(checkout: "/w")
    XCTAssertEqual(harness.calls.count, 1)
    harness.now = harness.now.addingTimeInterval(1)
    await model.refreshHostingMachines(checkout: "/w")
    XCTAssertEqual(harness.calls.count, 2)
    await model.refreshHostingMachines(checkout: "/other")
    XCTAssertEqual(harness.calls.map { $0.0 }, ["/w", "/w", "/other"])
  }

  @MainActor func testPickerDoesNotReplaceAnInFlightApprovalAndApprovalWaitsForARefresh() async {
    let harness = Harness()
    let model = harness.make()
    harness.block = true
    let approval = Task { await model.ask("mini", checkout: "/w") }
    await waitUntil { harness.waiting != nil }
    await model.refreshHostingMachines(checkout: "/w")
    XCTAssertEqual(harness.calls.count, 1)
    XCTAssertTrue(harness.calls[0].1)
    harness.block = false
    harness.waiting?.resume()
    await approval.value
    XCTAssertEqual(model.approvedHostingMachines(in: "/w"), ["mini"])

    harness.now = harness.now.addingTimeInterval(301)
    harness.waiting = nil
    harness.block = true
    let refresh = Task { await model.refreshHostingMachines(checkout: "/w") }
    await waitUntil { harness.waiting != nil }
    let nextApproval = Task { await model.ask("mini", checkout: "/w") }
    await Task.yield()
    XCTAssertEqual(harness.calls.count, 2)
    harness.block = false
    harness.waiting?.resume()
    await refresh.value
    await nextApproval.value
    XCTAssertEqual(harness.calls.map { $0.1 }, [true, false, true])
  }

  @MainActor func testFailedPickerRefreshIsAlsoThrottled() async {
    let harness = Harness()
    harness.fails = true
    let model = harness.make()
    await model.refreshHostingMachines(checkout: "/w")
    await model.refreshHostingMachines(checkout: "/w")
    XCTAssertEqual(harness.calls.count, 1)
    harness.now = harness.now.addingTimeInterval(301)
    await model.refreshHostingMachines(checkout: "/w")
    XCTAssertEqual(harness.calls.count, 2)
  }

  @MainActor func testEntriesChangedDuringARefreshGetAnotherRefreshWhenItEnds() async {
    let harness = Harness()
    harness.machines = "[\"a\", \"b\"]"
    let model = harness.make()
    await model.settings.refresh()
    harness.block = true
    let first = Task { await model.refreshStatuses(checkout: "/w", ask: false) }
    await waitUntil { harness.waiting != nil }
    let removal = Task { await model.remove("b", checkout: "/w") }
    await waitUntil { model.entries == ["a"] }
    await Task.yield()
    harness.block = false
    harness.waiting?.resume()
    await first.value
    await removal.value
    XCTAssertEqual(harness.calls.count, 2)
  }
}
