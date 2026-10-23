import Foundation
import Testing

@testable import StimKit

@Suite struct BuildHistoryTests {
  private static let hour = 3_600_000.0
  /// 2026-10-22 12:00 UTC.
  private static let noon = 1_792_670_400_000.0

  private static func line(
    id: String, ts: Double, project: String = "/w/app", platform: String = "ios", outcome: String = "succeeded",
    placement: String = #"{"where":"local"}"#, cache: String = #"{"result":"miss","key":"k","fingerprint":"f"}"#,
    phases: String = #"{"prepare":1000,"compile":5000}"#, extra: String = ""
  ) -> String {
    """
    {"ts":\(ts),"src":"builds","level":"info","msg":"m","event":"build","id":"\(id)","startedAt":\(ts - 6000),\
    "project":"\(project)","workspace":"app--1","branch":"main","platform":"\(platform)","configuration":"Debug",\
    "placement":\(placement),"cache":\(cache),"durationMs":6000,"phases":\(phases),"outcome":"\(outcome)",\
    "stimVersion":"1.26.0"\(extra)}
    """
  }

  private static func items(_ lines: [String]) -> [BuildHistoryItem] {
    BuildHistory.parse(Data(lines.joined(separator: "\n").utf8))
  }

  private static var utc: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
  }

  @Test func parsesNewestFirstAndSkipsWhatIsNotABuild() {
    let output = [
      Self.line(id: "a", ts: Self.noon),
      "not a record",
      #"{"src":"gc","ts":1}"#,
      Self.line(id: "c", ts: Self.noon + 2 * Self.hour, extra: #","somethingNew":1"#),
      Self.line(id: "b", ts: Self.noon + Self.hour),
      Self.line(id: "b", ts: Self.noon + Self.hour),
    ]
    #expect(Self.items(output).map(\.id) == ["c", "b", "a"])
    #expect(BuildHistory.parse(Data()).isEmpty)
  }

  @Test func anOutcomeNewerThanThisAppReadsAsFailed() {
    #expect(Self.items([Self.line(id: "a", ts: Self.noon, outcome: "exploded")])[0].outcome == .failed)
  }

  @Test func filtersByProjectPlatformMachineAndOutcome() {
    let offloaded = #"{"where":"offloaded","machine":"mini"}"#
    let all = Self.items([
      Self.line(id: "1", ts: Self.noon + 1),
      Self.line(id: "2", ts: Self.noon + 2, project: "/w/other", platform: "android"),
      Self.line(id: "3", ts: Self.noon + 3, placement: offloaded),
      Self.line(id: "4", ts: Self.noon + 4, outcome: "failed", placement: offloaded),
    ])
    func ids(_ filter: BuildFilter) -> [String] { all.filter(filter.matches).map(\.id) }
    #expect(ids(BuildFilter()) == ["4", "3", "2", "1"])
    #expect(ids(BuildFilter(project: "/w/other")) == ["2"])
    #expect(ids(BuildFilter(platform: "ios")) == ["4", "3", "1"])
    #expect(ids(BuildFilter(machine: "mini")) == ["4", "3"])
    #expect(ids(BuildFilter(machine: BuildFilter.thisMac)) == ["2", "1"])
    #expect(ids(BuildFilter(outcome: .failed)) == ["4"])
    #expect(ids(BuildFilter(platform: "ios", machine: "mini", outcome: .succeeded)) == ["3"])
    #expect(BuildHistory.items(on: "mini", in: all).map(\.id) == ["4", "3"])
  }

  @Test func groupsByLocalDayNewestFirst() {
    let all = Self.items([
      Self.line(id: "late", ts: Self.noon + 11 * Self.hour),
      Self.line(id: "noon", ts: Self.noon),
      Self.line(id: "yesterday", ts: Self.noon - 24 * Self.hour),
    ])
    let days = BuildHistory.days(all, calendar: Self.utc)
    #expect(days.map { $0.items.map(\.id) } == [["late", "noon"], ["yesterday"]])
    #expect(days[0].day > days[1].day)
    #expect(BuildHistory.days(all, BuildFilter(project: "/none"), calendar: Self.utc).isEmpty)
  }

  @Test func describesWhereTheBuildRanAndWhatTheCacheDid() {
    let all = Self.items([
      Self.line(id: "1", ts: Self.noon + 1, placement: #"{"where":"offloaded","machine":"mini"}"#),
      Self.line(id: "2", ts: Self.noon + 2, placement: #"{"where":"local","fellBack":true,"reason":"mini busy"}"#),
      Self.line(id: "3", ts: Self.noon + 3, cache: #"{"result":"hit","source":"remote","key":null,"fingerprint":null}"#),
      Self.line(id: "4", ts: Self.noon + 4, cache: #"{"result":"bypassed","key":null,"fingerprint":null}"#),
    ])
    let byId = Dictionary(uniqueKeysWithValues: all.map { ($0.id, $0) })
    #expect(byId["1"]?.whereText == "mini")
    #expect(byId["2"]?.whereText == "This Mac (fell back)")
    #expect(byId["3"]?.whereText == "This Mac")
    #expect(byId["3"]?.cacheText == "Remote cache hit")
    #expect(byId["4"]?.cacheText == "Cache bypassed")
    #expect(byId["1"]?.cacheText == "Cache miss")
  }

  @Test func theTimelineListsLocalPhasesThenTheMachinePhasesAndMarksTheFailedOne() throws {
    let item = try #require(
      Self.items([
        Self.line(
          id: "f", ts: Self.noon, outcome: "failed", placement: #"{"where":"offloaded","machine":"mini"}"#,
          phases: #"{"compile":43000,"zzz":1,"prepare":2000,"install":0}"#,
          extra:
            #","offloadPhases":{"build":40000,"sync":3000},"failure":{"code":"STIM_X","message":"boom","remedy":"retry","phase":"compile"}"#
        )
      ]).first)
    #expect(
      item.timeline.map(\.id) == ["local:prepare", "local:compile", "local:zzz", "machine:mini:sync", "machine:mini:build"])
    #expect(item.timeline.filter(\.failed).map(\.name) == ["compile"])
    #expect(item.timeline.first { $0.name == "sync" }?.title == "Sync")
    #expect(item.failure?.remedy == "retry")
  }

  @Test func choicesTellSameNamedProjectsApart() {
    let all = Self.items([
      Self.line(id: "1", ts: Self.noon + 1, project: "/a/app", platform: "android"),
      Self.line(id: "2", ts: Self.noon + 2, project: "/b/app"),
      Self.line(id: "3", ts: Self.noon + 3, project: "/a/zed", placement: #"{"where":"offloaded","machine":"mini"}"#),
    ])
    let choices = BuildHistory.choices(all)
    #expect(choices.projects.map(\.title) == ["app (a)", "app (b)", "zed"])
    #expect(choices.platforms == ["android", "ios"])
    #expect(choices.machines == ["mini"])
  }
}
