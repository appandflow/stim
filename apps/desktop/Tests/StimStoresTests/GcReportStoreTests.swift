import Foundation
import StimKit
import Testing

@testable import StimStores

@MainActor
private final class Clock {
  var date = Date(timeIntervalSince1970: 1_000_000)
  func advance(_ seconds: TimeInterval) { date = date.addingTimeInterval(seconds) }
}

private func gc(_ tag: String) -> GcReport {
  try! JSONDecoder().decode(
    GcReport.self, from: Data(#"{"sections":{"linkedWorktrees":[{"path":"\#(tag)","willRemove":false}]}}"#.utf8))
}

private func tag(_ report: GcReport?) -> String? {
  report?.sections.linkedWorktrees?.first?.path
}

@MainActor
struct GcReportStoreTests {
  @Test func reusesAReportYoungerThanMaxAgeAndRerunsAnOlderOne() async {
    let clock = Clock()
    let runs = Scripted<GcReport>()
    let store = GcReportStore(run: { try await runs.call() }, now: { clock.date })
    let first = Task { await store.report(maxAge: 60) }
    #expect(await until { runs.calls == 1 })
    runs.finish(0, .success(gc("one")))
    #expect(tag(await first.value) == "one")

    clock.advance(30)
    #expect(tag(await store.report(maxAge: 60)) == "one")
    #expect(runs.calls == 1)

    clock.advance(40)
    let second = Task { await store.report(maxAge: 60) }
    #expect(await until { runs.calls == 2 })
    runs.finish(1, .success(gc("two")))
    #expect(tag(await second.value) == "two")
  }

  @Test func anActionMakesAYoungReportStale() async {
    let clock = Clock()
    let runs = Scripted<GcReport>()
    let store = GcReportStore(run: { try await runs.call() }, now: { clock.date }, settleDelay: 3600)
    let first = Task { await store.report(maxAge: 60) }
    #expect(await until { runs.calls == 1 })
    runs.finish(0, .success(gc("before")))
    _ = await first.value

    clock.advance(1)
    store.changed()
    let second = Task { await store.report(maxAge: 60) }
    #expect(await until { runs.calls == 2 })
    runs.finish(1, .success(gc("after")))
    #expect(tag(await second.value) == "after")
  }

  @Test func aRunThatStartedBeforeAnActionIsNotReusedAfterIt() async {
    let clock = Clock()
    let runs = Scripted<GcReport>()
    let store = GcReportStore(run: { try await runs.call() }, now: { clock.date }, settleDelay: 3600)
    let before = Task { await store.report(maxAge: 60) }
    #expect(await until { runs.calls == 1 })

    clock.advance(1)
    store.changed()
    let after = Task { await store.report(maxAge: 60) }
    await settle()
    #expect(runs.calls == 1)

    runs.finish(0, .success(gc("old")))
    #expect(tag(await before.value) == "old")
    #expect(await until { runs.calls == 2 })
    runs.finish(1, .success(gc("new")))
    #expect(tag(await after.value) == "new")
    #expect(tag(store.report) == "new")
  }

  @Test func callersDuringARunShareIt() async {
    let runs = Scripted<GcReport>()
    let store = GcReportStore(run: { try await runs.call() })
    let first = Task { await store.report(maxAge: 60) }
    let second = Task { await store.report(maxAge: 60) }
    #expect(await until { runs.calls == 1 })
    await settle()
    #expect(runs.calls == 1)
    runs.finish(0, .success(gc("shared")))
    let a = tag(await first.value)
    let b = tag(await second.value)
    #expect(a == "shared" && b == "shared")
    #expect(!store.running)
  }

  @Test func startedAfterSkipsAReportFromBeforeThatMoment() async {
    let clock = Clock()
    let runs = Scripted<GcReport>()
    let store = GcReportStore(run: { try await runs.call() }, now: { clock.date })
    let first = Task { await store.report(maxAge: 60) }
    #expect(await until { runs.calls == 1 })
    runs.finish(0, .success(gc("early")))
    _ = await first.value

    clock.advance(5)
    #expect(tag(await store.report(startedAfter: clock.date.addingTimeInterval(-10))) == "early")
    let later = Task { await store.report(startedAfter: clock.date) }
    #expect(await until { runs.calls == 2 })
    runs.finish(1, .success(gc("late")))
    #expect(tag(await later.value) == "late")
  }

  @Test func aFailedRunKeepsTheLastReportAndItsAgeAndReportsTheError() async {
    let clock = Clock()
    let runs = Scripted<GcReport>()
    let store = GcReportStore(run: { try await runs.call() }, now: { clock.date })
    let first = Task { await store.report(maxAge: 60) }
    #expect(await until { runs.calls == 1 })
    runs.finish(0, .success(gc("good")))
    _ = await first.value
    let reportedAt = store.at

    clock.advance(100)
    let second = Task { await store.report(maxAge: 60) }
    #expect(await until { runs.calls == 2 })
    runs.finish(1, .failure(Failed()))
    let failed = await second.value
    #expect(failed == nil)
    #expect(tag(store.report) == "good")
    #expect(store.error == "scripted failure")
    #expect(store.at == reportedAt)
    #expect(!store.running)

    let third = Task { await store.report(maxAge: 60) }
    #expect(await until { runs.calls == 3 })
    runs.finish(2, .success(gc("recovered")))
    #expect(tag(await third.value) == "recovered")
    #expect(store.error == nil)
  }

  @Test func actionsInABurstRunGcOnceAfterTheyStop() async {
    let runs = Scripted<GcReport>()
    let store = GcReportStore(run: { try await runs.call() }, settleDelay: 0.05)
    store.changed()
    store.changed()
    store.changed()
    #expect(await until { runs.calls == 1 })
    await settle()
    #expect(runs.calls == 1)
    runs.finish(0, .success(gc("settled")))
    #expect(await until { tag(store.report) == "settled" })
  }
}
