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
