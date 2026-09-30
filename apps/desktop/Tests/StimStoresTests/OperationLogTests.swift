import Foundation
import StimKit
import Testing

@testable import StimStores

@MainActor
private func start(_ log: OperationLog, _ title: String = "t", exit status: Int32?, launchFails: Bool = false) async -> ActionRun
{
  let run = ActionRun(title: title, steps: [StimCommand(["x"], cwd: "/w")], key: "/w")
  log.began(run)
  guard let status else { return run }
  await withCheckedContinuation { continuation in
    run.start(launch: { _, _, onExit in
      if launchFails { throw Failed() }
      DispatchQueue.global().async { onExit(status) }
    }) { continuation.resume() }
  }
  return run
}

@MainActor
struct OperationLogTests {
  @Test func aRunningRunCountsAsRunningAndNeverNeedsAttention() async {
    let log = OperationLog()
    let run = await start(log, exit: nil)
    #expect(log.running.map(\.id) == [run.id])
    #expect(log.attentionCount == 0)
  }

  @Test func aFailureNobodyOpenedNeedsAttentionUntilItsSheetOpensOrTheListIsSeen() async {
    let log = OperationLog()
    let failed = await start(log, exit: 2)
    log.finished(failed, viewed: false)
    let launchFailed = await start(log, exit: 0, launchFails: true)
    log.finished(launchFailed, viewed: false)
    #expect(log.attentionCount == 2)
    log.markSeen(failed)
    #expect(log.attentionCount == 1)
    log.markAllSeen()
    #expect(log.attentionCount == 0)
  }

  @Test func successAndAFailureEndingUnderAnOpenSheetNeverNeedAttention() async {
    let log = OperationLog()
    log.finished(await start(log, exit: 0), viewed: false)
    log.finished(await start(log, exit: 1), viewed: true)
    #expect(log.attentionCount == 0)
  }

  @Test func historyKeepsEveryRunningRunAndOnlyTheNewestFinishedOnes() async {
    let log = OperationLog()
    let running = await start(log, "running", exit: nil)
    var finished: [ActionRun] = []
    for index in 0..<(OperationLog.retainedFinished + 5) {
      let run = await start(log, "run \(index)", exit: 1)
      log.finished(run, viewed: false)
      finished.append(run)
    }
    #expect(log.runs.count == OperationLog.retainedFinished + 1)
    #expect(log.runs.contains { $0.id == running.id })
    #expect(log.runs.first?.id == finished.last?.id)
    #expect(!log.runs.contains { $0.id == finished[0].id })
    #expect(log.attentionCount == OperationLog.retainedFinished)
  }

  @Test func aFinishedRunRecordsWhenItEndedAndDescribesItsFailure() async {
    let log = OperationLog()
    let ok = await start(log, exit: 0)
    let bad = await start(log, exit: 4)
    #expect(ok.finishedAt != nil && !ok.needsAttention)
    #expect(bad.finishedAt != nil && bad.needsAttention)
    #expect(bad.statusLine == "Exited 4")
  }
}
