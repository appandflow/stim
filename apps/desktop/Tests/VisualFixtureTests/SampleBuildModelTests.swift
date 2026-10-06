import Foundation
import StimKit
import XCTest

@testable import StimDesktop

final class SampleBuildModelTests: XCTestCase {
  @MainActor private final class Harness {
    let sample = WizardSample(applicationSupport: URL(fileURLWithPath: "/fixture"))
    var commands: [StimCommand] = []
    var files: Set<URL> = []
    var markedAfter: [String] = []
    var now = Date(timeIntervalSince1970: 100)
    var fallback = false
    var refusal = false
    var waitForCancel = false
    var failInstall = false
    var cancelled = false
    var invalidOutput: WizardCommandOutput?
    var invalidLocal = false
    func make() -> SampleBuildModel {
      SampleBuildModel(
        dependencies: .init(
          sample: sample,
          run: { command, onLine in
            self.commands.append(command)
            var stdout = ""
            if command.program == "npm", self.failInstall {
              return WizardCommandOutput(exit: 1, stdout: Data(), stderr: "Registry unavailable")
            }
            if command.arguments.first == "ios" {
              onLine(OutputLine(.stderr, "building"))
              if command.arguments.contains("local") == self.invalidLocal, let output = self.invalidOutput { return output }
              if self.waitForCancel {
                do { try await Task.sleep(for: .seconds(100)) } catch {
                  self.cancelled = true
                  throw error
                }
              }
              if command.arguments.contains("local") {
                self.now = self.now.addingTimeInterval(250)
                stdout = "{\"launched\":true}"
              } else if self.refusal {
                return WizardCommandOutput(
                  exit: 1,
                  stdout: Data(
                    "{\"code\":\"STIM_OFFLOAD_REFUSED\",\"message\":\"Worker refused\",\"remedy\":\"Exact fix\"}".utf8),
                  stderr: "")
              } else {
                stdout =
                  self.fallback
                  ? "{\"launched\":true}" : "{\"offloadedTo\":\"\(command.arguments[2])\",\"launched\":\"bundling\"}"
              }
            }
            if command.arguments.first == "logs" {
              stdout =
                "{\"event\":\"offload_done\",\"timings\":{\"offerMs\":1000,\"syncMs\":3000,\"workerMs\":161000,\"fetchMs\":4000,\"totalMs\":172000}}"
            }
            return WizardCommandOutput(exit: 0, stdout: Data(stdout.utf8), stderr: "")
          }, exists: { self.files.contains($0) }, create: { self.files.insert($0) },
          move: { from, to in
            self.files.remove(from)
            self.files.insert(to)
          }, remove: { self.files.remove($0) },
          mark: {
            self.markedAfter = self.commands.map(\.program)
            self.files.insert($0)
          }, now: { self.now }))
    }
  }
  @MainActor private func settle(_ model: SampleBuildModel) async {
    for _ in 0..<1000 {
      if !model.preparing && !model.running { return }
      await Task.yield()
    }
    XCTFail("Model did not settle")
  }
  @MainActor func testPreparationMarksOnlyAfterCommandsAndCompleteSampleIsReused() async {
    let harness = Harness()
    let model = harness.make()
    model.prepare()
    await settle(model)
    XCTAssertTrue(model.sampleReady)
    XCTAssertEqual(harness.markedAfter, ["npx", "npm", "git", "git", "git"])
    let reused = harness.make()
    let count = harness.commands.count
    reused.prepare()
    await settle(reused)
    XCTAssertTrue(reused.sampleReady)
    XCTAssertEqual(harness.commands.count, count)
  }
  @MainActor func testPreparationFailureLeavesNoMarkerAndRetrySucceeds() async {
    let harness = Harness()
    harness.failInstall = true
    let model = harness.make()
    model.prepare()
    await settle(model)
    XCTAssertFalse(model.sampleReady)
    XCTAssertFalse(harness.files.contains(harness.sample.marker))
    guard case .failed(_, let message, _) = model.test.state else { return XCTFail() }
    XCTAssertTrue(message.contains("Registry unavailable"))
    harness.failInstall = false
    model.prepare()
    await settle(model)
    XCTAssertTrue(model.sampleReady)
    XCTAssertTrue(harness.commands.contains { $0.arguments == ["stop"] })
  }
  @MainActor func testBothBuildsPassAndCleanupRunsButSilentFallbackDoesNotPass() async {
    for fallback in [false, true] {
      let harness = Harness()
      harness.files.insert(harness.sample.marker)
      harness.fallback = fallback
      let model = harness.make()
      model.prepare()
      await settle(model)
      model.run(entry: "mini:7447")
      await settle(model)
      XCTAssertEqual(model.test.passed, !fallback)
      XCTAssertEqual(harness.commands.filter { $0.arguments.contains("local") }.count, fallback ? 0 : 1)
      XCTAssertEqual(harness.commands.last?.arguments, ["stop"])
      XCTAssertTrue(harness.commands.allSatisfy { $0.cwd == harness.sample.folder.path })
      if !fallback {
        XCTAssertEqual(model.test.localMs, 250000)
        XCTAssertEqual(model.test.timings?.workerMs, 161000)
      }
    }
  }
  @MainActor func testRefusalReachesStateUnchangedAndSkipTerminatesBeforeStop() async {
    let refused = Harness()
    refused.files.insert(refused.sample.marker)
    refused.refusal = true
    let model = refused.make()
    model.prepare()
    await settle(model)
    model.run(entry: "mini")
    await settle(model)
    XCTAssertEqual(model.test.state, .failed(code: "STIM_OFFLOAD_REFUSED", message: "Worker refused", remedy: "Exact fix"))
    XCTAssertEqual(refused.commands.last?.arguments, ["stop"])
    let harness = Harness()
    harness.files.insert(harness.sample.marker)
    harness.waitForCancel = true
    let running = harness.make()
    running.prepare()
    await settle(running)
    running.run(entry: "mini")
    for _ in 0..<1000 {
      if harness.commands.contains(where: { $0.arguments.first == "ios" }) { break }
      await Task.yield()
    }
    await running.skip()
    XCTAssertTrue(harness.cancelled)
    XCTAssertEqual(running.test.state, .skipped)
    XCTAssertFalse(running.running)
    XCTAssertEqual(harness.commands.last?.arguments, ["stop"])
  }

  @MainActor func testNonObjectBuildOutputShowsStderrAndStillStopsTheSample() async {
    for local in [false, true] {
      for stdout in ["", "Usage: stim ios", "[]"] {
        let harness = Harness()
        harness.files.insert(harness.sample.marker)
        harness.invalidLocal = local
        harness.invalidOutput = WizardCommandOutput(exit: 9, stdout: Data(stdout.utf8), stderr: "Unknown build option")
        let model = harness.make()
        model.prepare()
        await settle(model)
        model.run(entry: "mini")
        await settle(model)
        guard case .failed(_, let message, _) = model.test.state else { return XCTFail("Invalid output passed") }
        XCTAssertTrue(message.contains("Unknown build option"))
        XCTAssertTrue(message.contains("9"))
        XCTAssertEqual(harness.commands.last?.arguments, ["stop"])
      }
    }
  }
}
