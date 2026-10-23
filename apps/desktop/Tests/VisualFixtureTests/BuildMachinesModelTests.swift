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
    var remoteMachines = "[]"
    var requests: [String] = []
    var androidCalls: [String] = []
    var androidMachines = "[]"
    var androidFails = false
    var remoteServer = ""
    var local: LocalStim? = LocalStim(version: "1.25.0", isRelease: true)

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
        pollInterval: .milliseconds(1), now: { self.now },
        machineAccess: { checkout, ask in
          self.calls.append((checkout, ask))
          if self.block { await withCheckedContinuation { self.waiting = $0 } }
          if self.fails { throw StimCLI.Failure.exited(1, stderr: "Doctor failed") }
          var object: [String: Any] = [
            "project": checkout, "findings": [],
            "remoteMachines": try JSONSerialization.jsonObject(with: Data(self.remoteMachines.utf8)),
          ]
          if let hosts = self.hosts { object["deviceHosts"] = hosts.map { ["machine": $0, "state": "approved"] } }
          return try JSONDecoder().decode(DoctorReport.self, from: JSONSerialization.data(withJSONObject: object))
        },
        androidDoctor: { checkout in
          self.androidCalls.append(checkout)
          if self.androidFails { throw ServerError(code: "unsupported", message: "Update the local stim-server.") }
          let object: [String: Any] = [
            "project": checkout, "findings": [],
            "remoteMachines": try JSONSerialization.jsonObject(with: Data(self.androidMachines.utf8)),
          ]
          return try JSONDecoder().decode(DoctorReport.self, from: JSONSerialization.data(withJSONObject: object))
        },
        serverVersion: { _, _ in "1.25.0" },
        localStim: { self.local },
        request: { method, _ in
          self.requests.append(method)
          let reply =
            method == "machines.update.start"
            ? #"{"startedAt":"2026-10-22T10:00:00.000Z"}"# : self.remoteServer
          return try JSONDecoder().decode(JSONValue.self, from: Data(reply.utf8))
        })
    }

    static let needsUpdate =
      #"[{"machine":"mini","state":"approved","offloadable":false,"problems":[{"code":"stim-build","reason":"Stim build a there, b here"}]}]"#

    static func remote(version: String, acceptsClientBuilds: Bool = false, finished: Bool = false) -> String {
      let last = finished ? #"{"at":"2026-10-22T10:00:01.000Z","target":"x","ok":true,"message":"done"}"# : "null"
      return
        #"{"remote":{"server":{"version":"\#(version)","stimBuild":"a"},"service":"dev.stim.server","acceptsClientBuilds":\#(acceptsClientBuilds),"running":null,"last":\#(last)},"unreachable":null,"upload":null}"#
    }
  }

  @MainActor func testAndroidReportLoadsWhenAMachinePageOpensNotOnTheListsPoll() async throws {
    let harness = Harness()
    harness.remoteMachines =
      #"[{"machine":"mini","state":"approved","offloadable":false,"dnsName":"mini.ts.net","problems":[{"code":"stim-build","reason":"Stim build a there, b here"}]}]"#
    harness.androidMachines =
      #"[{"machine":"mini","state":"approved","offloadable":false,"problems":[{"code":"jdk","reason":"JDK 25 there, 17 here"}]}]"#
    let model = harness.make()
    await model.refreshStatuses(checkout: "/w", ask: false)
    await model.refreshStatuses(checkout: "/w", ask: false)
    XCTAssertEqual(harness.androidCalls, [])
    XCTAssertEqual(model.detail(for: "mini", checkout: "/w").androidMessage, nil)

    await model.loadDetails("mini", checkout: "/w")
    XCTAssertEqual(harness.androidCalls, ["/w"])
    let detail = model.detail(for: "mini", checkout: "/w")
    XCTAssertEqual(detail.groups.map(\.platform), [.machine, .android])
    XCTAssertEqual(detail.groups.last?.issues.map(\.code), ["jdk"])
    XCTAssertEqual(detail.versions.first { $0.label == "mini" }?.value, "stim-server 1.25.0")

    await model.loadDetails("mini", checkout: "/w")
    XCTAssertEqual(harness.androidCalls.count, 1, "a report younger than 30 seconds is reused")
    harness.now = harness.now.addingTimeInterval(31)
    await model.loadDetails("mini", checkout: "/w")
    XCTAssertEqual(harness.androidCalls.count, 2)
  }

  @MainActor func testAndroidReportFailureIsShownOnThePageAndKeepsTheListsIssues() async throws {
    let harness = Harness()
    harness.remoteMachines =
      #"[{"machine":"mini","state":"approved","offloadable":false,"problems":[{"code":"ndk","reason":"Android: no NDK 27.1.12297006 there"}]}]"#
    harness.androidFails = true
    let model = harness.make()
    await model.refreshStatuses(checkout: "/w", ask: false)
    await model.loadDetails("mini", checkout: "/w")
    let detail = model.detail(for: "mini", checkout: "/w")
    XCTAssertEqual(detail.androidMessage, "Could not check the Android tools: Update the local stim-server.")
    XCTAssertEqual(detail.groups.flatMap(\.issues).map(\.code), ["ndk"])
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

  @MainActor func testSettingsReadFailureShowsUntilTheListLoads() async {
    let harness = Harness()
    let model = harness.make()
    XCTAssertNil(model.settingsReadFailure)
    await model.settings.refresh()
    XCTAssertNil(model.entries)
    XCTAssertNotNil(model.settingsReadFailure)
    harness.machines = "[\"mini\"]"
    await model.settings.refresh()
    XCTAssertNil(model.settingsReadFailure)
    harness.machines = nil
    await model.settings.refresh()
    XCTAssertEqual(model.entries, ["mini"])
    XCTAssertNil(model.settingsReadFailure)
  }

  @MainActor func testAutomaticCheckSkipsDoctorWithoutMachinesOrSettingAndFollowsBuildAndListChanges() async {
    let harness = Harness()
    harness.machines = "[]"
    let model = harness.make()
    await model.settings.refresh()
    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-a")
    XCTAssertEqual(harness.calls.count, 0)

    harness.machines = "[\"mini\"]"
    await model.settings.refresh()
    await model.checkMachinesIfDue(checkout: "/w", enabled: false, identity: "build-a")
    XCTAssertEqual(harness.calls.count, 0)

    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-a")
    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-a")
    XCTAssertEqual(harness.calls.count, 1)

    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-b")
    XCTAssertEqual(harness.calls.count, 2)

    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: nil)
    await model.checkMachinesIfDue(checkout: nil, enabled: true, identity: "build-c")
    XCTAssertEqual(harness.calls.count, 2)

    await model.checkMachinesIfDue(checkout: "/w", enabled: false, identity: "build-b")
    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-b")
    XCTAssertEqual(harness.calls.count, 3)

    harness.machines = "[\"mini\", \"studio\"]"
    await model.settings.refresh()
    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-b")
    XCTAssertEqual(harness.calls.count, 4)

    harness.now = harness.now.addingTimeInterval(15 * 60)
    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-b")
    XCTAssertEqual(harness.calls.count, 5)
  }

  @MainActor func testAutomaticCheckWaitsWhileAnotherRefreshIsRunning() async {
    let harness = Harness()
    harness.machines = "[\"mini\"]"
    let model = harness.make()
    await model.settings.refresh()
    harness.block = true
    let running = Task { await model.refreshStatuses(checkout: "/w", ask: false) }
    await waitUntil { harness.waiting != nil }
    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-a")
    XCTAssertEqual(harness.calls.count, 1)
    harness.block = false
    harness.waiting?.resume()
    await running.value
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
    XCTAssertEqual(harness.calls.count, 3)
    harness.block = false
    harness.waiting?.resume()
    await refresh.value
    await nextApproval.value
    XCTAssertEqual(harness.calls.map { $0.1 }, [true, false, false, true, false])
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

  @MainActor func testAnOlderLocalBuildIsNeverSentToANewerRemoteMachine() async {
    UserDefaults.standard.set(true, forKey: AppPreferences.Key.updatesBuildMachines)
    defer { UserDefaults.standard.removeObject(forKey: AppPreferences.Key.updatesBuildMachines) }
    let harness = Harness()
    harness.local = LocalStim(version: "1.24.0", isRelease: true)
    harness.remoteMachines = Harness.needsUpdate
    harness.remoteServer = Harness.remote(version: "1.25.0", acceptsClientBuilds: true)
    let model = harness.make()
    await model.refreshStatuses(checkout: "/w", ask: false)
    await model.update("mini", checkout: "/w")
    XCTAssertEqual(harness.requests, ["machines.update.status"])
    XCTAssertNil(model.updates["mini"])
    XCTAssertEqual(
      model.install(for: model.check(in: "/w")!.statuses[0])?.block?.action, StimInstallBlock.Action.checkForUpdates)
  }

  @MainActor func testBlockedInstallsSendNothingAndAnAcceptedOneIsRequestedOnce() async {
    let harness = Harness()
    harness.remoteMachines = Harness.needsUpdate
    harness.remoteServer = Harness.remote(version: "1.24.0", finished: true)
    let model = harness.make()
    harness.local = nil
    await model.refreshStatuses(checkout: "/w", ask: false)
    await model.update("mini", checkout: "/w")
    XCTAssertFalse(harness.requests.contains("machines.update.start"))
    harness.local = LocalStim(version: "1.25.0", isRelease: false)
    await model.refreshStatuses(checkout: "/w", ask: false)
    await model.update("mini", checkout: "/w")
    XCTAssertFalse(harness.requests.contains("machines.update.start"))
    harness.local = LocalStim(version: "1.25.0", isRelease: true)
    await model.refreshStatuses(checkout: "/w", ask: false)
    await model.update("mini", checkout: "/w")
    XCTAssertEqual(harness.requests.filter { $0 == "machines.update.start" }.count, 1)
  }

  @MainActor func testTheWizardInstallsOnAMachineTheSettingsPageHasNotChecked() async throws {
    let harness = Harness()
    harness.remoteServer = Harness.remote(version: "1.24.0", finished: true)
    let model = harness.make()
    let status = try JSONDecoder().decode(
      [BuildMachineStatus].self, from: Data(Harness.needsUpdate.utf8))[0]
    await model.update("mini", checkout: "/w", status: status)
    XCTAssertTrue(harness.requests.isEmpty)
    await model.readRemoteServers([status])
    await model.update("mini", checkout: "/w", status: status)
    XCTAssertEqual(harness.requests.filter { $0 == "machines.update.start" }.count, 1)
  }

  @MainActor func testAutomaticCheckRunsAgainWhenThisMacsServerWasNotConnected() async {
    let harness = Harness()
    harness.machines = "[\"mini\"]"
    harness.remoteMachines = Harness.needsUpdate
    harness.remoteServer = Harness.remote(version: "1.24.0")
    harness.local = nil
    let model = harness.make()
    await model.settings.refresh()
    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-a")
    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-a")
    XCTAssertEqual(harness.calls.count, 2)
    harness.local = LocalStim(version: "1.25.0", isRelease: true)
    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-a")
    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-a")
    XCTAssertEqual(harness.calls.count, 3)
  }

  @MainActor func testAFailingDoctorDoesNotCancelTheAutomaticCheckThrottle() async {
    let harness = Harness()
    harness.machines = "[\"mini\"]"
    harness.fails = true
    harness.local = nil
    let model = harness.make()
    await model.settings.refresh()
    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-a")
    await model.checkMachinesIfDue(checkout: "/w", enabled: true, identity: "build-a")
    XCTAssertEqual(harness.calls.count, 1)
  }
}
