import XCTest

@testable import StimKit

final class ActivityProgressTests: XCTestCase {
  func testParsesLabelFactAndDuration() {
    let steps = ActivityProgress.parse(["  port        released 8084"])
    XCTAssertEqual(steps, [ProgressStep(label: "port", fact: "released 8084", duration: nil, state: .done)])
  }

  func testExtractsTrailingDuration() {
    let steps = ActivityProgress.parse(["  fingerprint a3f9b1.. hit (2s)"])
    XCTAssertEqual(steps.count, 1)
    XCTAssertEqual(steps[0].fact, "a3f9b1.. hit")
    XCTAssertEqual(steps[0].duration, "2s")
    XCTAssertEqual(steps[0].state, .done)
  }

  func testKeepsParensInsideTheFactAndOnlyStripsTheTrailingOne() {
    let steps = ActivityProgress.parse(["  device      stim-app-412 (iPhone 17 26.5) (BF2A..) booted (9s)"])
    XCTAssertEqual(steps.count, 1)
    XCTAssertEqual(steps[0].fact, "stim-app-412 (iPhone 17 26.5) (BF2A..) booted")
    XCTAssertEqual(steps[0].duration, "9s")
  }

  func testDistinctFactsUnderTheSameLabelBecomeSeparateRows() {
    let steps = ActivityProgress.parse([
      "  stop        supervisor pid 34856",
      "  stop        collector ios pid 45268",
    ])
    XCTAssertEqual(steps.count, 2)
    XCTAssertEqual(steps[0].fact, "supervisor pid 34856")
    XCTAssertEqual(steps[1].fact, "collector ios pid 45268")
  }

  func testHeartbeatsForTheSamePhaseCollapseIntoOneRow() {
    let steps = ActivityProgress.parse([
      "  build       still compiling (1m00s of ~3m10s)",
      "  build       still compiling (1m30s of ~3m10s)",
      "  build       ok (1m48s)",
    ])
    XCTAssertEqual(steps.count, 1)
    XCTAssertEqual(steps[0].fact, "ok")
    XCTAssertEqual(steps[0].duration, "1m48s")
    XCTAssertEqual(steps[0].state, .done)
  }

  func testRunningHeartbeatState() {
    let steps = ActivityProgress.parse(["  pods        still installing (1m30s of ~1m40s)"])
    XCTAssertEqual(steps[0].state, .running)
  }

  func testWaitingStateAndLookup() {
    let steps = ActivityProgress.parse([
      "  port        released 8084",
      "  build       waiting on /w/app-411 (pid 41233, 1m30s elapsed)",
    ])
    XCTAssertEqual(steps[1].state, .waiting)
    XCTAssertEqual(ActivityProgress.waitingStep(steps)?.label, "build")
  }

  func testWaitingRowResolvesInPlaceOnceTheWaitEnds() {
    let steps = ActivityProgress.parse([
      "  lock        waiting 40s for stim worktree warm --refresh (pid 41233)",
      "  lock        acquired shared (seed current)",
    ])
    XCTAssertEqual(steps.count, 1)
    XCTAssertEqual(steps[0].state, .done)
    XCTAssertEqual(steps[0].fact, "acquired shared")
    XCTAssertEqual(steps[0].duration, "seed current")
  }

  func testIgnoresIndentedLinesOutsideTheProgressLabels() {
    let steps = ActivityProgress.parse([
      "  ios stim-1372-mobile (iPhone 18 Pro 27.0) 1E4FC7B7-C74E-4B21-B1C6-F485F7CE4ABB",
      "  20.2G",
      "  /s/workspaces/x: workspace directory not resolved: it has no workspace.json",
      "  device      shut down stim-e2e-2",
    ])
    XCTAssertEqual(steps.map(\.label), ["device"])
  }

  func testGcStepsSkipItsReportRowsAndResolveTheExitWait() {
    let steps = ActivityProgress.parse([
      "  daemons     watchman pid 32725: checking 12 roots",
      "  watchman pid 32725 50M, up 17m, idle",
      "  daemons     waiting up to 10s for 1 Gradle daemon to exit: pid 51234",
      "  daemons     checking 0 Gradle daemons and 1 Kotlin daemon",
    ])
    XCTAssertEqual(
      steps.map(\.fact),
      [
        "watchman pid 32725: checking 12 roots", "checking 0 Gradle daemons and 1 Kotlin daemon",
      ])
    XCTAssertNil(ActivityProgress.waitingStep(steps))
  }

  func testFailedState() {
    let steps = ActivityProgress.parse([
      "  device      failed to shut down stim-e2e-2: simulator 9C1F.. is still Booted"
    ])
    XCTAssertEqual(steps[0].state, .failed)
  }

  func testErrorLabelIsAlwaysFailed() {
    let steps = ActivityProgress.parse(["  error       STIM_CLAIM_UNAVAILABLE"])
    XCTAssertEqual(steps[0].state, .failed)
  }

  func testIgnoresNonPhaseLinesAndContinuationLines() {
    let steps = ActivityProgress.parse([
      "$ stim stop",
      "                not the default branch (main); worktrees seeded from this copy",
      "",
      "  port        released 8084",
    ])
    XCTAssertEqual(steps.count, 1)
    XCTAssertEqual(steps[0].label, "port")
  }

  func testNoStepsWhenNothingHasPrintedYet() {
    XCTAssertEqual(ActivityProgress.parse([]), [])
  }
}

final class ActionOutputTests: XCTestCase {
  private func fixtureLines() throws -> [String] {
    let url = Bundle.module.url(forResource: "stim-ios-run", withExtension: "txt", subdirectory: "Fixtures")!
    return try String(contentsOf: url, encoding: .utf8).components(separatedBy: "\n").filter { !$0.isEmpty }
  }

  func testIncrementalRowsEqualTheFullParseAfterEveryLine() throws {
    let lines = try fixtureLines()
    XCTAssertTrue(ActivityProgress.parse(lines).count > 5)
    var accumulator = ActivityProgress.Accumulator()
    for (index, line) in lines.enumerated() {
      accumulator.append(line)
      XCTAssertEqual(accumulator.steps, ActivityProgress.parse(Array(lines[...index])))
    }
  }

  func testBatchedAppendsGiveTheFullParseWhateverTheBatchSizes() throws {
    let lines = try fixtureLines().map { OutputLine(.stderr, $0) }
    for size in [1, 2, 3, 7, lines.count] {
      var output = ActionOutput(keepsStdout: false)
      for start in stride(from: 0, to: lines.count, by: size) {
        output.append(Array(lines[start..<min(start + size, lines.count)]))
      }
      XCTAssertEqual(output.steps, ActivityProgress.parse(lines.map(\.text)))
      XCTAssertEqual(output.lines, lines)
    }
  }

  func testKeepsOnlyTheTailButTheWholeStdoutPayload() {
    let total = ActionOutput.retainedLines * 3 + 17
    var output = ActionOutput(keepsStdout: true)
    output.append((0..<total).map { OutputLine($0 % 2 == 0 ? .stdout : .stderr, "line \($0)") })
    XCTAssertLessThanOrEqual(output.lines.count, 2 * ActionOutput.retainedLines)
    XCTAssertGreaterThanOrEqual(output.lines.count, ActionOutput.retainedLines)
    XCTAssertEqual(output.lines.last?.text, "line \(total - 2)")
    XCTAssertEqual(output.droppedCount + output.lines.count, total / 2)
    XCTAssertTrue(output.lines.allSatisfy { $0.channel == .stderr })
    let expected = (0..<total).filter { $0 % 2 == 0 }.map { "line \($0)" }.joined(separator: "\n")
    XCTAssertEqual(String(decoding: output.stdout, as: UTF8.self), expected)
  }

  func testDropsStdoutWhenNotAJSONCommand() {
    var output = ActionOutput(keepsStdout: false)
    output.append([OutputLine(.stdout, "x")])
    XCTAssertTrue(output.stdout.isEmpty)
  }

  func testAppendingLinesStaysLinear() {
    func seconds(_ count: Int) -> TimeInterval {
      let lines = (0..<count).map { OutputLine(.stderr, $0 % 10 == 0 ? "  build       still compiling (\($0)s)" : "line \($0)") }
      let start = Date()
      var output = ActionOutput(keepsStdout: false)
      for batch in stride(from: 0, to: count, by: 50) { output.append(Array(lines[batch..<min(batch + 50, count)])) }
      XCTAssertEqual(output.droppedCount + output.lines.count, count)
      return Date().timeIntervalSince(start)
    }
    _ = seconds(1000)
    let small = seconds(50_000)
    let large = seconds(500_000)
    print("ActionOutput append: 50k lines \(small)s, 500k lines \(large)s")
    XCTAssertLessThan(large, small * 10 * 3, "10x the lines took more than 3x the linear time")
  }

  func testBatcherDeliversInOrderInFewBatches() async {
    let received = LockedBox<[[String]]>([])
    let batcher = OutputBatcher(interval: 0.05) { batch in received.mutate { $0.append(batch.map(\.text)) } }
    DispatchQueue.global().async {
      for index in 0..<1000 { batcher.receive(OutputLine(.stdout, "\(index)")) }
    }
    try? await Task.sleep(for: .milliseconds(500))
    await MainActor.run { batcher.flush() }
    let batches = received.value
    XCTAssertEqual(batches.flatMap { $0 }, (0..<1000).map(String.init))
    XCTAssertLessThan(batches.count, 50)
  }
}

private final class LockedBox<Value>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value
  init(_ value: Value) { stored = value }
  var value: Value { lock.withLock { stored } }
  func mutate(_ change: (inout Value) -> Void) { lock.withLock { change(&stored) } }
}
