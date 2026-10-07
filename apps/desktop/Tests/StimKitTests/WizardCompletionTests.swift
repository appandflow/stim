import Foundation
import XCTest

@testable import StimKit

final class WizardCompletionTests: XCTestCase {
  private func status(_ problems: [[String: String]], offloadable: Bool = false) throws -> BuildMachineStatus {
    try JSONDecoder().decode(
      BuildMachineStatus.self,
      from: JSONSerialization.data(withJSONObject: [
        "machine": "mini", "state": "approved", "offloadable": offloadable, "problems": problems,
      ]))
  }
  private func journal(_ steps: [SetupJournal.Step]) -> SetupJournal {
    SetupJournal(nodeId: "self", ticket: SetupTicket.generate(now: Date()), capabilities: [.build], steps: steps)
  }

  func testDoctorComparisonOverridesJournalAndBusyDoesNotBlock() throws {
    let journal = journal([.init(id: "tools.Xcode", state: .ok, title: "Xcode", detail: "26.0")])
    let report = toolsReport(
      journal: journal,
      status: try status([
        ["code": "xcode", "reason": "Xcode 26.0 there, Xcode 27.0 here"],
        ["code": "busy", "reason": "At capacity"],
      ]), capabilities: [.build])
    guard case .mismatch = report.first?.state else { return XCTFail("Doctor mismatch must override the journal success") }
    XCTAssertEqual(report.last?.state, .busy)
    XCTAssertFalse(report.last!.state.blocks)
    let ready = toolsReport(
      journal: self.journal([.init(id: "tools.CocoaPods", state: .pending, title: "CocoaPods", fix: "old fix")]),
      status: try status([], offloadable: true), capabilities: [.build])
    XCTAssertFalse(ready.contains { $0.state.blocks })
    let hosted = toolsReport(
      journal: nil,
      status: try status([
        ["code": "checkout", "reason": "not a build checkout"],
        ["code": "cocoapods", "reason": "no CocoaPods there"],
      ]), capabilities: [.deviceHost])
    XCTAssertFalse(hosted.contains { $0.state.blocks })

  }

  func testJournalOnlyUsesPendingFixAndHostingDoesNotRequireBuildOnlyTools() {
    let steps: [SetupJournal.Step] = [
      .init(id: "tools.Xcode", state: .ok, title: "Xcode"),
      .init(id: "tools.iOS runtime", state: .pending, title: "iOS runtime", fix: "exact journal fix"),
      .init(id: "tools.CocoaPods", state: .pending, title: "CocoaPods", fix: "pods fix"),
      .init(id: "tools.Stim build", state: .ok, title: "Stim build"),
    ]
    let builds = toolsReport(journal: journal(steps), status: nil, capabilities: [.build])
    XCTAssertEqual(builds.first?.state, .ok)
    XCTAssertEqual(builds.first { $0.id == "runtime" }?.state, .missing("exact journal fix"))
    let hosting = toolsReport(journal: journal(steps), status: nil, capabilities: [.deviceHost], android: true)
    XCTAssertEqual(hosting.first { $0.id == "cocoapods" }?.state, .notNeeded)
    XCTAssertEqual(hosting.first { $0.id == "jdk" }?.state, .notNeeded)
    XCTAssertTrue(hosting.first { $0.id == "runtime" }!.state.blocks)
    XCTAssertEqual(toolsReport(journal: nil, status: nil, capabilities: [.build]).first?.state, .checking)
  }

  func testAndroidIsOnDemandAndFixesPreserveJournalFix() throws {
    let android = try status([["code": "jdk", "reason": "JDK none there, 17 here"]])
    XCTAssertEqual(toolsReport(journal: nil, status: android, capabilities: [.build]).first { $0.id == "jdk" }?.state, .notNeeded)
    let row = toolsReport(journal: nil, status: android, capabilities: [.build], android: true).first { $0.id == "jdk" }!
    XCTAssertNotNil(row.state.fix)
    XCTAssertFalse(row.blocks)
    let pending = journal([.init(id: "tools.CocoaPods", state: .pending, title: "CocoaPods", fix: "install pinned bundle")])
    XCTAssertEqual(
      toolsReport(
        journal: pending, status: try status([["code": "bundler", "reason": "no Bundler there"]]), capabilities: [.build]
      ).first { $0.id == "cocoapods" }?.state.fix, "install pinned bundle")
  }

  func testOffloadProofRejectsFallbackWrongMachineAndUnverifiedLaunch() throws {
    for launch in ["true", "\"bundling\"", "\"unverified\"", "false", "\"future\""] {
      for machine in ["mini", "other"] {
        let result = try OffloadResult.parse(
          Data("{\"offloadedTo\":\"\(machine)\",\"launched\":\(launch)}".utf8), machine: "mini", exit: 0)
        XCTAssertEqual(result, machine == "mini" && ["true", "\"bundling\""].contains(launch) ? .success : .unproven)
      }
    }
    XCTAssertEqual(try OffloadResult.parse(Data("{\"launched\":true}".utf8), machine: "mini", exit: 0), .unproven)
    XCTAssertEqual(
      try OffloadResult.parse(Data("{\"offloadedTo\":\"mini\",\"launched\":true}".utf8), machine: "mini", exit: 1), .unproven)
    let refusal = Data("{\"code\":\"STIM_OFFLOAD_REFUSED\",\"message\":\"Exact message\",\"remedy\":\"Exact remedy\"}".utf8)
    guard case .refused(let parsed) = try OffloadResult.parse(refusal, machine: "mini", exit: 1) else { return XCTFail() }
    XCTAssertEqual(parsed.code, "STIM_OFFLOAD_REFUSED")
    XCTAssertEqual(parsed.message, "Exact message")
    XCTAssertEqual(parsed.remedy, "Exact remedy")
    XCTAssertFalse(try OffloadResult.localPassed(Data("{\"launched\":\"unverified\"}".utf8), exit: 0))
    XCTAssertFalse(try OffloadResult.localPassed(Data("{\"offloadedTo\":\"mini\",\"launched\":true}".utf8), exit: 0))
    XCTAssertTrue(try OffloadResult.localPassed(Data("{\"launched\":\"bundling\"}".utf8), exit: 0))
  }

  func testFixesUseTheSelectedMachinesDoctorFindingAndPreferTheJournal() throws {
    let report = try JSONDecoder().decode(
      DoctorReport.self,
      from: Data(
        """
        {"project":"/fixture","findings":[
        {"code":"build-machine-jdk","level":"cost","title":"Build machine other JDK","detail":"mismatch","fix":"other fix"},
        {"code":"build-machine-jdk","level":"cost","title":"Build machine mini JDK","detail":"mismatch","fix":"selected fix"},
        {"code":"build-machine-checkout","level":"cost","title":"Build machine mini checkout","detail":"checkout","fix":"checkout fix"}]}
        """.utf8))
    let status = try status([
      ["code": "jdk", "reason": "JDK 17 there, none here"],
      ["code": "checkout", "reason": "this app is not in a git checkout"],
    ])
    let rows = toolsReport(journal: nil, status: status, capabilities: [.build], android: true, findings: report.findings)
    XCTAssertEqual(rows.first { $0.id == "jdk" }?.state.fix, "selected fix")
    XCTAssertEqual(rows.first { $0.id == "checkout" }?.state.fix, "checkout fix")
    XCTAssertTrue(rows.first { $0.id == "jdk" }!.onThisMac)
    XCTAssertTrue(rows.first { $0.id == "checkout" }!.onThisMac)
    let journal = journal([.init(id: "tools.JDK", state: .pending, title: "JDK", fix: "journal fix")])
    XCTAssertEqual(
      toolsReport(journal: journal, status: status, capabilities: [.build], android: true, findings: report.findings)
        .first { $0.id == "jdk" }?.state.fix, "journal fix")
  }

  func testProseFixesAndCommandExamplesAreNotCopyableShellCommands() {
    XCTAssertTrue(wizardFixIsCommand("xcodebuild -downloadPlatform iOS"))
    XCTAssertTrue(wizardFixIsCommand("gem install bundler"))
    XCTAssertFalse(wizardFixIsCommand("Install Bundler (`gem install bundler`) on mini."))
    XCTAssertFalse(wizardFixIsCommand("Use a build machine with the same CPU architecture as this Mac."))
    XCTAssertFalse(wizardFixIsCommand("stim-server service update --release <version>"))
  }

  func testTimingsComeFromTheLastRealOffloadDoneRecord() throws {
    let log = """
      {"src":"build","level":"info","event":"offload_done","msg":"built on mini","timings":{"offerMs":889,"syncMs":126,"workerMs":793572,"fetchMs":7811,"totalMs":802413,"worker":{"syncMs":67,"buildMs":776856},"uploadedBytes":4721634},"ts":1,"slot":"default"}
      {"src":"build","level":"info","event":"offload_done","msg":"built on mini","timings":{"offerMs":1,"syncMs":2,"workerMs":3,"fetchMs":4,"totalMs":10},"ts":2,"slot":"default"}
      """
    XCTAssertEqual(try BuildTimings.record(Data(log.utf8)).totalMs, 10)
  }

  func testReducerNeedsRemoteProofTimingsAndLocalProofAndSkipStopsLateEvents() throws {
    let data = Data(
      "{\"event\":\"offload_done\",\"timings\":{\"offerMs\":1000,\"syncMs\":3000,\"workerMs\":161000,\"fetchMs\":4000,\"totalMs\":172000}}"
        .utf8)
    let times = try BuildTimings.record(data)
    XCTAssertEqual(times.syncMs + times.offerMs, 4000)
    XCTAssertEqual(times.workerMs, 161000)
    XCTAssertThrowsError(try BuildTimings.record(Data("{\"event\":\"other\"}".utf8))) { error in
      XCTAssertTrue(error is BuildTimings.Failure)
      XCTAssertTrue(error.localizedDescription.contains("timings"))
    }
    var test = BuildTest()
    XCTAssertEqual(test.outcome, .notRun)
    test.apply(.prepared)
    XCTAssertEqual(test.outcome, .notRun)
    test.apply(.start)
    test.apply(.timings(times))
    test.apply(.localStart)
    test.apply(.localFinished(passed: true, ms: 250000))
    XCTAssertFalse(test.passed)
    XCTAssertEqual(test.outcome, .notRun)
    test.apply(.offload(.success))
    test.apply(.timings(times))
    test.apply(.localStart)
    XCTAssertEqual(test.state, .localBuilding)
    XCTAssertEqual(test.outcome, .notRun)
    test.apply(.localFinished(passed: false, ms: 250000))
    XCTAssertFalse(test.passed)
    test.apply(.skip)
    XCTAssertEqual(test.outcome, .skippedAfterFailure("The sample did not launch from a local build."))
    test.apply(.start)
    test.apply(.skip)
    XCTAssertEqual(test.outcome, .skipped)
    test.apply(.start)
    test.apply(.offload(.success))
    test.apply(.timings(times))
    test.apply(.localStart)
    test.apply(.localFinished(passed: true, ms: 250000))
    XCTAssertTrue(test.passed)
    XCTAssertEqual(test.outcome, .passed)
    XCTAssertEqual(test.outcome.symbol, "checkmark.circle.fill")
    XCTAssertEqual(test.outcome.accessibilityLabel, "Test build, done")
    XCTAssertNil(test.outcome.summaryText)
    XCTAssertEqual(test.localMs, 250000)
    test.apply(.skip)
    test.apply(.localFinished(passed: true, ms: 1))
    test.apply(.progress("late"))
    test.apply(.fail(code: "LATE", message: "Cancelled build", remedy: nil))
    XCTAssertEqual(test.state, .skipped)
    XCTAssertEqual(test.outcome, .skipped)
  }

  func testOutcomeDistinguishesNotRunSkipFailureAndSkipAfterFailure() {
    var test = BuildTest()
    XCTAssertEqual(test.outcome.symbol, "minus.circle.fill")
    XCTAssertEqual(test.outcome.accessibilityLabel, "Test build, not run")
    XCTAssertEqual(test.outcome.summaryText, "Test build not run.")
    test.apply(.skip)
    XCTAssertEqual(test.outcome, .skipped)
    XCTAssertEqual(test.outcome.symbol, "minus.circle.fill")
    XCTAssertEqual(test.outcome.accessibilityLabel, "Test build, skipped")
    XCTAssertEqual(test.outcome.summaryText, "Test build skipped.")
    test.apply(.start)
    test.apply(.fail(code: "REFUSED", message: "Worker refused", remedy: nil))
    XCTAssertEqual(test.outcome, .failed("Worker refused"))
    XCTAssertEqual(test.outcome.symbol, "exclamationmark.triangle.fill")
    XCTAssertEqual(test.outcome.accessibilityLabel, "Test build, failed")
    XCTAssertEqual(test.outcome.summaryText, "Test build failed: Worker refused")
    test.apply(.skip)
    XCTAssertFalse(test.passed)
    XCTAssertEqual(test.outcome, .skippedAfterFailure("Worker refused"))
    XCTAssertEqual(test.outcome.symbol, "minus.circle.fill")
    XCTAssertEqual(test.outcome.accessibilityLabel, "Test build, skipped after a failed run")
    XCTAssertEqual(test.outcome.summaryText, "Test build skipped after a failed run.")
    test.apply(.prepare)
    test.apply(.prepared)
    test.apply(.skip)
    XCTAssertEqual(test.outcome, .skipped)
  }

  func testComparisonAndModeDefaultsDoNotClaimSlowerBuildsAreFaster() {
    XCTAssertTrue(speedComparison(machine: "mini", offloadMs: 172000, localMs: 250000).contains("faster"))
    XCTAssertTrue(speedComparison(machine: "mini", offloadMs: 250000, localMs: 172000).contains("slower"))
    XCTAssertTrue(speedComparison(machine: "mini", offloadMs: 172000, localMs: 172000).contains("same time"))
    XCTAssertEqual(WizardMode.defaultChoice(passed: true, changedMode: true, current: "off"), .auto)
    XCTAssertEqual(WizardMode.defaultChoice(passed: false, changedMode: true, current: "auto"), .off)
    XCTAssertEqual(WizardMode.defaultChoice(passed: true, changedMode: false, current: "force"), .force)
  }

  func testSampleRemovalRejectsOtherFoldersAndSymlinkEscapes() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let sample = WizardSample(applicationSupport: root)
    try FileManager.default.createDirectory(at: sample.onboarding, withIntermediateDirectories: true)
    XCTAssertTrue(sample.permitsRemoval(sample.folder))
    XCTAssertFalse(sample.permitsRemoval(sample.onboarding))
    XCTAssertFalse(sample.permitsRemoval(sample.onboarding.appendingPathComponent("other")))
    let outside = root.appendingPathComponent("outside")
    try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: sample.folder, withDestinationURL: outside)
    XCTAssertFalse(sample.permitsRemoval(sample.folder))
  }
}
