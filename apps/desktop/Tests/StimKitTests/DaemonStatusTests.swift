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

  @Test func anOlderStimOrAMalformedBlockReportsNoDaemon() throws {
    #expect(try daemon(nil) == nil)
    #expect(try daemon(#"{"mode":5}"#) == nil)
  }
}
