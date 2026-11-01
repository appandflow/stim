import Foundation
import Testing

@testable import StimKit

@Suite struct GcHistoryTests {
  private let output = """
    {"ts":1792619100000,"src":"gc","level":"info","msg":"Cleared worktree /w/old (2.0 GB)","event":"gc_item","runId":"a1","trigger":"manual","options":{"delete":true,"worktrees":true,"olderThan":7},"kind":"worktree","status":"done","label":"/w/old","id":null,"path":"/w/old","bytes":2000000000,"detail":"merged"}
    {"ts":1792619101000,"src":"gc","level":"info","msg":"Kept worktree /w/busy","event":"gc_item","runId":"a1","trigger":"manual","options":{"delete":true,"worktrees":true,"olderThan":7},"kind":"worktree","status":"kept","label":"/w/busy","id":null,"path":"/w/busy","bytes":null,"detail":"in use"}
    {"ts":1792619300000,"src":"gc","level":"error","msg":"Failed","event":"gc_item","runId":"p-9","trigger":"maintenance","via":"ios","kind":"cache","status":"failed","label":"Build cache","id":"/c","path":"/c","bytes":null,"detail":"EBUSY"}
    not a record
    {"ts":1792619200000,"src":"gc","level":"info","msg":"x","event":"gc_item","runId":"z","trigger":"future","kind":"somethingNew","status":"done","label":"y","id":null,"path":null,"bytes":10,"detail":null,"extra":1}

    """

  @Test func groupsItemsByRunNewestRunFirstKeepingWriteOrder() {
    let runs = GcHistory.runs(GcHistory.parse(Data(output.utf8)))
    #expect(runs.map(\.id) == ["p-9", "z", "a1"])
    #expect(runs[2].items.map(\.label) == ["/w/old", "/w/busy"])
  }

  @Test func summarizesWhatARunClearedKeptAndFailed() {
    let runs = GcHistory.runs(GcHistory.parse(Data(output.utf8)))
    let manual = runs[2]
    #expect(manual.summary == "Cleared 1, kept 1, freed 2 GB")
    #expect(manual.freedBytes == 2_000_000_000)
    #expect(manual.reason == "stim gc --delete --worktrees --older-than 7")
    #expect(runs[0].summary == "Failed 1")
    #expect(runs[0].title == "Automatic maintenance")
    #expect(runs[0].reason == "Started by stim ios")
  }

  @Test func anUnknownTriggerAndKindStillDecode() {
    let run = GcHistory.runs(GcHistory.parse(Data(output.utf8)))[1]
    #expect(run.title == "Cleanup")
    #expect(run.items[0].kindTitle == "somethingNew")
  }

  @Test func noOutputIsNoRuns() {
    #expect(GcHistory.runs(GcHistory.parse(Data())).isEmpty)
  }
}
