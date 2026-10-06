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
    XCTAssertEqual(
      report.first?.state, .mismatch("Install Xcode 27.0 from the App Store, then run `sudo xcodebuild -runFirstLaunch`"))
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

  func testAndroidIsOnDemandAndCodeFixesPreserveJournalFix() throws {
    let fixes = [
      "runtime": "xcodebuild -downloadPlatform iOS", "cocoapods": "brew install cocoapods", "bundler": "gem install bundler",
      "jdk": "brew install --cask zulu@17", "android-sdk": "Install Android Studio, or set ANDROID_HOME",
      "ndk": "install it with sdkmanager there", "build-tools": "install it with sdkmanager there",
      "compile-sdk": "install it with sdkmanager there", "stim-build": "Install This Mac's Build",
      "arch": "Use a Mac with the same CPU", "checkout": "Run Stim from a git checkout",
      "disk": "Free disk space on the build Mac", "unreachable": "Check stim-server on the build Mac",
    ]
    for (code, fix) in fixes {
      let rows = toolsReport(
        journal: nil, status: try status([["code": code, "reason": "no tool there"]]), capabilities: [.build], android: true)
      XCTAssertTrue(rows.contains { $0.state.fix == fix }, code)
    }
    let android = try status([["code": "jdk", "reason": "JDK none there, 17 here"]])
    XCTAssertEqual(toolsReport(journal: nil, status: android, capabilities: [.build]).first { $0.id == "jdk" }?.state, .notNeeded)
    XCTAssertEqual(
      toolsReport(journal: nil, status: android, capabilities: [.build], android: true).first { $0.id == "jdk" }?.state,
      .missing("brew install --cask zulu@17"))
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
    XCTAssertFalse(OffloadResult.localPassed(Data("{\"launched\":\"unverified\"}".utf8), exit: 0))
    XCTAssertFalse(OffloadResult.localPassed(Data("{\"offloadedTo\":\"mini\",\"launched\":true}".utf8), exit: 0))
    XCTAssertTrue(OffloadResult.localPassed(Data("{\"launched\":\"bundling\"}".utf8), exit: 0))
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
    XCTAssertThrowsError(try BuildTimings.record(Data("{\"event\":\"other\"}".utf8)))
    var test = BuildTest()
    test.apply(.prepared)
    test.apply(.start)
    test.apply(.timings(times))
    test.apply(.localStart)
    test.apply(.localFinished(passed: true, ms: 250000))
    XCTAssertFalse(test.passed)
    test.apply(.offload(.success))
    test.apply(.timings(times))
    test.apply(.localStart)
    XCTAssertEqual(test.state, .localBuilding)
    test.apply(.localFinished(passed: false, ms: 250000))
    XCTAssertFalse(test.passed)
    test.apply(.start)
    test.apply(.offload(.success))
    test.apply(.timings(times))
    test.apply(.localStart)
    test.apply(.localFinished(passed: true, ms: 250000))
    XCTAssertTrue(test.passed)
    XCTAssertEqual(test.localMs, 250000)
    test.apply(.skip)
    test.apply(.localFinished(passed: true, ms: 1))
    test.apply(.progress("late"))
    XCTAssertEqual(test.state, .skipped)
  }

  func testComparisonAndModeDefaultsDoNotClaimSlowerBuildsAreFaster() {
    XCTAssertEqual(
      speedComparison(machine: "mini", offloadMs: 172000, localMs: 250000),
      "Builds on mini were 1:18 faster than building here for this sample.")
    XCTAssertEqual(
      speedComparison(machine: "mini", offloadMs: 250000, localMs: 172000),
      "Builds on mini were 1:18 slower than building here for this sample.")
    XCTAssertTrue(speedComparison(machine: "mini", offloadMs: 172000, localMs: 172000).contains("same time"))
    XCTAssertEqual(WizardMode.defaultChoice(passed: true, changedMode: true, current: "off"), .auto)
    XCTAssertEqual(WizardMode.defaultChoice(passed: false, changedMode: true, current: "auto"), .off)
    XCTAssertEqual(WizardMode.defaultChoice(passed: true, changedMode: false, current: "force"), .force)
    XCTAssertEqual(
      summaryLines(builds: ["old", "mini:7447"], hosts: ["mini"], mode: .off),
      ["Wrote offload.machines = [\"old\",\"mini:7447\"]", "Wrote hosting.machines = [\"mini\"]", "offload.mode = off"])
  }

  func testSampleRemovalRejectsOtherFoldersAndSymlinkEscapesAndCommandsUseOwnedCheckout() throws {
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
    let commands = sample.prepareCommands
    XCTAssertEqual(commands.first?.program, "npx")
    XCTAssertTrue(commands.first!.arguments.contains("create-expo-app@5.0.0"))
    XCTAssertTrue(commands.first!.arguments.contains("expo-template-blank@58.0.15"))
    XCTAssertEqual(commands.first?.cwd, sample.onboarding.path)
    XCTAssertTrue(commands.dropFirst().allSatisfy { $0.cwd == sample.folder.path })
    XCTAssertEqual(commands.last?.arguments.suffix(3), ["commit", "-m", "sample"])
    XCTAssertTrue(commands.last!.arguments.contains("commit.gpgsign=false"))
  }
}
