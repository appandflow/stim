import Foundation
import Testing

@testable import StimKit

@Suite struct DaemonStatusTests {
  private func daemon(_ block: String?) throws -> DaemonStatus? {
    let field = block.map { ",\"daemon\":\($0)" } ?? ""
    return try JSONDecoder().decode(StatusPayload.self, from: Data("{\"environments\":[]\(field)}".utf8)).daemon
  }

  private func block(mode: String = "on", running: Bool = true, level: String) -> String {
    let runner = running ? #"{"pid":42,"since":"2026-11-02T10:00:00.000Z"}"# : "null"
    return """
      {"mode":"\(mode)","running":\(runner),"lastTickAt":"2026-11-02T11:00:00.000Z","intervalMs":60000,
       "pressure":{"level":"\(level)","disk":"\(level)","memory":"normal","reasons":["14 GB free on /"],"memoryWarningSince":null}}
      """
  }

  @Test func aRaisedLevelAsksAPersonOnlyWhenItIsCriticalOrNoDaemonActs() throws {
    #expect(try daemon(block(level: "normal"))?.isRaised == false)
    #expect(try daemon(block(level: "high"))?.asksAboutPressure == false)
    #expect(try daemon(block(level: "critical"))?.asksAboutPressure == true)
    #expect(try daemon(block(running: false, level: "high"))?.asksAboutPressure == true)
    #expect(try daemon(block(mode: "report", level: "high"))?.asksAboutPressure == true)
    #expect(try daemon(block(level: "high"))?.headline == "Pressure high: 14 GB free on /")
  }

  @Test func theLastActionsComeNewestFirst() throws {
    let status = try #require(
      try daemon(
        #"{"mode":"on","running":null,"lastTickAt":null,"intervalMs":null,"recent":[{"rung":1,"kind":"idle-stage","target":"/w/app","workspace":"/w/app","outcome":"done","bytes":2048,"detail":"","at":"2026-11-02T10:00:00.000Z"},{"rung":4,"kind":"dormant-stage","target":"/w/old","outcome":"would","bytes":0,"detail":"","at":"2026-11-02T11:00:00.000Z"}]}"#
      ))
    #expect(status.level == "normal")
    #expect(status.lastActions().map(\.title) == ["Would: Dormant stage of old", "Idle stage of app"])
    #expect(status.lastActions(1).count == 1)
  }

  @Test func savedInventoryKeepsSubtypeAgesAndUnknownWorktreeSizes() throws {
    let status = try #require(
      try daemon(
        #"{"mode":"on","gcMarks":{"at":1000,"state":"ready","stale":[],"candidates":{"readState":"ready","outputs":{"state":"ready","count":2,"knownBytes":2048.5,"unknownSizeCount":1,"oldestMarkedAt":"2026-11-02T10:00:00.000Z"},"dependencies":{"state":"ready","count":0,"knownBytes":0,"unknownSizeCount":0,"oldestMarkedAt":"2026-11-02T11:00:00.000Z"},"worktrees":{"state":"ready","count":1,"knownBytes":0,"unknownSizeCount":1,"oldestMarkedAt":"2026-11-01T10:00:00.000Z"}}}}"#
      ))
    let candidates = try #require(status.gcMarks?.candidates)
    #expect(candidates.readState == "ready")
    #expect(candidates.outputs.count == 2)
    #expect(candidates.outputs.knownBytes == 2048.5)
    #expect(candidates.outputs.unknownSizeCount == 1)
    #expect(candidates.dependencies.count == 0)
    #expect(candidates.worktrees.unknownSizeCount == 1)
    let worktreeDate = try #require(candidates.worktrees.oldestDate)
    let outputDate = try #require(candidates.outputs.oldestDate)
    let dependencyDate = try #require(candidates.dependencies.oldestDate)
    #expect(worktreeDate < outputDate)
    #expect(outputDate < dependencyDate)
  }

  @Test func partialInventoryDoesNotInventMissingCountsOrDates() throws {
    let status = try #require(
      try daemon(
        #"{"mode":"report","gcMarks":{"candidates":{"readState":"partial","outputs":{"state":"partial","count":1,"knownBytes":0,"unknownSizeCount":1},"dependencies":{"state":"unavailable"},"worktrees":{"state":"partial"}}}}"#
      ))
    let candidates = try #require(status.gcMarks?.candidates)
    #expect(candidates.readState == "partial")
    #expect(candidates.outputs.count == 1)
    #expect(candidates.dependencies.count == nil)
    #expect(candidates.dependencies.knownBytes == nil)
    #expect(candidates.worktrees.count == nil)
    #expect(candidates.outputs.oldestDate == nil)
    #expect(status.diskPacer == nil)
  }

  @Test func predictiveCleanupDoesNotChangeMeasuredPressure() throws {
    let status = try #require(
      try daemon(
        #"{"mode":"on","pressure":{"level":"normal","disk":"normal","reasons":[]},"diskPacer":[{"device":1,"volume":"/","observedAt":1000,"freeMb":40000,"fillMbPerSecond":2.5,"firstFreeMs":750,"predictive":{"since":500,"targetFreeMb":45000,"lastAttemptAt":700,"checkedAt":1000,"freeMb":40000}},{"device":2,"volume":"/Volumes/External","observedAt":1000,"freeMb":100000,"fillMbPerSecond":null,"firstFreeMs":null}]}"#
      ))
    #expect(status.level == "normal")
    #expect(status.isRaised == false)
    let volumes = try #require(status.diskPacer)
    #expect(volumes.count == 2)
    #expect(volumes[0].predictive?.targetFreeMb == 45000)
    #expect(volumes[0].firstFreeMs == 750)
    #expect(volumes[1].fillMbPerSecond == nil)
    #expect(volumes[1].firstFreeMs == nil)
    #expect(volumes[1].predictive == nil)
    #expect(status.gcMarks == nil)
  }

  @Test func malformedCleanupBlocksDoNotHideCriticalPressure() throws {
    let missingSubtype = try #require(
      try daemon(
        #"{"mode":"on","pressure":{"level":"critical","disk":"critical","reasons":["disk low"]},"gcMarks":{"candidates":{"readState":"partial","outputs":{"state":"partial"},"dependencies":{"state":"unavailable"}}},"diskPacer":[{"device":1,"volume":"/","observedAt":1000,"freeMb":10000}]}"#
      ))
    #expect(missingSubtype.level == "critical")
    #expect(missingSubtype.asksAboutPressure)
    #expect(missingSubtype.gcMarks == nil)
    #expect(missingSubtype.diskPacer?.count == 1)
    let invalidPacer = try #require(
      try daemon(
        #"{"mode":"on","pressure":{"level":"critical","disk":"critical","reasons":["disk low"]},"gcMarks":{"state":"ready","stale":[]},"diskPacer":{"device":"invalid"}}"#
      ))
    #expect(invalidPacer.level == "critical")
    #expect(invalidPacer.asksAboutPressure)
    #expect(invalidPacer.gcMarks != nil)
    #expect(invalidPacer.diskPacer == nil)
  }

  @Test func cachedZeroRequiresAKnownSizedCandidate() throws {
    let decoder = JSONDecoder()
    let unknown = try decoder.decode(
      DaemonStatus.CandidateCoverage.self,
      from: Data(
        #"{"state":"ready","count":1,"knownBytes":0,"unknownSizeCount":1}"#.utf8))
    #expect(unknown.knownSubtotal == nil)
    let measuredZero = try decoder.decode(
      DaemonStatus.CandidateCoverage.self,
      from: Data(
        #"{"state":"ready","count":1,"knownBytes":0,"unknownSizeCount":0}"#.utf8))
    #expect(measuredZero.knownSubtotal == 0)
    let mixed = try decoder.decode(
      DaemonStatus.CandidateCoverage.self,
      from: Data(
        #"{"state":"partial","count":2,"knownBytes":4096,"unknownSizeCount":1}"#.utf8))
    #expect(mixed.knownSubtotal == 4096)
    #expect(mixed.unknownSizeCount == 1)
  }

  @Test func olderDaemonPayloadOmitsOptionalInventoryAndPacer() throws {
    let status = try #require(try daemon(block(level: "normal")))
    #expect(status.gcMarks == nil)
    #expect(status.diskPacer == nil)
    #expect(try daemon(#"{"mode":"on","gcMarks":{"state":"ready","stale":[]}}"#)?.gcMarks?.candidates == nil)
  }

  @Test func anOlderStimOrAMalformedBlockReportsNoDaemon() throws {
    #expect(try daemon(nil) == nil)
    #expect(try daemon(#"{"mode":5}"#) == nil)
  }
}
