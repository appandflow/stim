import Foundation
import Testing

@testable import StimKit

@Suite struct LogRecordTests {
  let records: [LogRecord] = {
    let url = Bundle.module.url(forResource: "logs", withExtension: "ndjson", subdirectory: "Fixtures")!
    let text = try! String(contentsOf: url, encoding: .utf8)
    return text.split(separator: "\n").compactMap(LogRecord.parse)
  }()

  @Test func decodesEveryCapturedRecordAndIgnoresFieldsItDoesNotModel() {
    #expect(records.count == 10)
    #expect(
      records.map(\.src) == [
        "metro", "metro", "metro", "build", "build", "device", "device", "device", "device", "build",
      ])
    #expect(records[1].marker == true)
    #expect(records[3].platform == "ios")
  }

  @Test func spellsOutLevelSourceSlotAndGroupSizeForVoiceOver() {
    let time = { (record: LogRecord) in record.date.formatted(LogRecord.timeFormat) }
    #expect(
      records[4].accessibilityLabel(source: "build", title: "Bundling failed", recordCount: 3)
        == "Warning, build, slot ipad, Bundling failed, \(time(records[4])), 3 records")
    #expect(
      records[7].accessibilityLabel(source: "native", title: "crash")
        == "Fatal, native, slot duo, crash, \(time(records[7]))")
  }

  @Test func leavesTheSlotEmptyOnUntaggedRecords() {
    #expect(records[0].slot == nil)
    #expect(records[4].slot == "ipad")
  }

  @Test func keepsMultiLineMessagesWhole() {
    #expect(records[6].msg.split(separator: "\n", omittingEmptySubsequences: false).count == 5)
    #expect(records[5].msg.contains("\n\tpath: satisfied"))
  }

  @Test func decodesStackFramesWithoutLineNumbers() throws {
    let crash = records[7]
    #expect(crash.level == .fatal)
    #expect(crash.event == "native_crash")
    let stack = try #require(crash.stack)
    #expect(stack.count == 3)
    #expect(stack[0].description == "+0x6575712d7400 [unsymbolicated] (<unknown image>)")
    #expect(stack[0].line == nil)
  }

  @Test func decodesAFrameWithUnexpectedTypesAsFarAsItCan() throws {
    let record = try #require(
      LogRecord.parse(
        #"{"ts":1,"src":"client","level":"error","msg":"boom","stack":[{"file":"a.js","line":"12","column":3,"fn":"f"}]}"#
      ))
    #expect(record.stack?.first?.description == "f (a.js)")
  }

  @Test func keepsANewerSourceAndLevel() throws {
    let record = try #require(LogRecord.parse(#"{"ts":1,"src":"network","level":"trace","msg":"x"}"#))
    #expect(record.src == "network")
    #expect(record.source == nil)
    #expect(record.level == .info)
  }

  @Test func decodesTheDeviceOfAnAgentAction() throws {
    let record = try #require(
      LogRecord.parse(
        #"{"ts":1790340231708,"src":"agent","level":"info","msg":"Tapped @e7","event":"agent_action","command":"press","session":"e2e1175","platform":"ios","deviceId":"2FA9C340-A259-4420-A617-316DC159FF84","details":{"command":"press","ref":"e7","x":193,"y":393}}"#
      ))
    #expect(record.source == .agent)
    #expect(record.deviceId == "2FA9C340-A259-4420-A617-316DC159FF84")
    #expect(record.command == "press")
  }

  @Test func skipsLinesThatAreNotRecords() {
    #expect(LogRecord.parse("") == nil)
    #expect(LogRecord.parse("Debugger listening on ws://127.0.0.1") == nil)
    #expect(LogRecord.parse(#"{"ts":1,"src":"metro","level":"info"}"#) == nil)
  }
}

@Suite struct LogQueryTests {
  @Test func passesNoSourceWhenEverySourceIsSelectedSoErrorsKeepsTheDefaultScope() {
    var query = LogQuery()
    query.errorsOnly = true
    #expect(query.params(workspace: "/app") == ["workspace": .string("/app"), "tail": .number(5000), "errors": .bool(true)])
  }

  @Test func anInterruptedBuildStopsBeforeTheNextRecordedRunInItsOwnSlot() throws {
    var query = try #require(LogQuery.build(platform: "ios", slot: "ipad", startedAt: "2026-10-02T12:00:00Z"))
    let history = try JSONDecoder().decode(
      [BuildHistoryEntry].self,
      from: Data(
        """
        [{"platform":"ios","status":"ok","cacheHit":"local","startedAt":"2026-10-02T12:00:10Z",
          "finishedAt":"2026-10-02T12:00:11Z","result":"succeeded","slot":"iphone","phases":{}},
         {"platform":"ios","status":"ok","cacheHit":false,"startedAt":"2026-10-02T12:00:20Z",
          "finishedAt":"2026-10-02T12:00:30Z","result":"succeeded","slot":"ipad","phases":{}}]
        """.utf8))
    query.buildRun = query.buildRun?.bounded(history: history, active: nil)
    let start = try #require(query.buildRun).startedAt.timeIntervalSince1970 * 1000
    func record(_ offset: Double) throws -> LogRecord {
      try #require(LogRecord.parse("{\"ts\":\(start + offset),\"src\":\"build\",\"level\":\"debug\",\"msg\":\"raw\"}"))
    }
    #expect(query.includes(try record(19_999)))
    #expect(!query.includes(try record(20_000)))
    let active = try JSONDecoder().decode(
      Build.self,
      from: Data(
        """
        {"platform":"ios","slot":"ipad","state":"running","phase":"prepare","startedAt":"2026-10-02T12:00:15Z",
         "phaseStartedAt":"2026-10-02T12:00:15Z","outcome":null,"expectedMs":null,"expectedPhaseMs":null,"basis":0}
        """.utf8))
    query.buildRun = query.buildRun?.bounded(history: history, active: active)
    #expect(!query.includes(try record(15_000)))
  }

  @Test func includesRecordsExactlyAtMillisecondBuildBoundaries() throws {
    for milliseconds in [1, 12, 123, 456, 999] {
      let timestamp = String(format: "2026-10-29T13:01:00.%03dZ", milliseconds)
      let query = try #require(
        LogQuery.build(platform: "ios", slot: "default", startedAt: timestamp, finishedAt: timestamp))
      let epochMilliseconds = 1_793_278_860_000 + milliseconds
      let record = try #require(
        LogRecord.parse("{\"ts\":\(epochMilliseconds),\"src\":\"build\",\"level\":\"debug\",\"msg\":\"boundary\"}"))
      #expect(query.includes(record), "\(timestamp)")
      var interrupted = try #require(
        LogQuery.build(platform: "ios", slot: "default", startedAt: "2026-10-29T13:00:59.000Z"))
      let next = try JSONDecoder().decode(
        [BuildHistoryEntry].self,
        from: Data(
          """
          [{"platform":"ios","status":"ok","cacheHit":false,"startedAt":"\(timestamp)",
            "result":"succeeded","slot":"default","phases":{}}]
          """.utf8))
      interrupted.buildRun = interrupted.buildRun?.bounded(history: next, active: nil)
      #expect(!interrupted.includes(record), "\(timestamp)")
    }
  }

  @Test func passesEveryFilter() {
    var query = LogQuery()
    query.sources = [.build, .metro]
    query.slot = "ipad"
    query.minimumLevel = .warn
    query.search = "Bundl(ed|ing)"
    query.tail = 10
    #expect(
      query.params(workspace: "/app") == [
        "workspace": .string("/app"), "tail": .number(10), "sources": .array([.string("metro"), .string("build")]),
        "slot": .string("ipad"), "level": .string("warn"), "grep": .string("Bundl(ed|ing)"),
      ])
  }

  @Test func buildOutputReadsTheWholeRunAndRejectsOtherRunsAndPlatforms() throws {
    var query = try #require(
      LogQuery.build(
        platform: "ios", slot: "ipad", startedAt: "2026-10-02T12:00:00.000Z",
        finishedAt: "2026-10-02T12:00:10.000Z"))
    #expect(query.params(workspace: "/app") == ["workspace": .string("/app"), "sources": .array([.string("build")])])
    let start = try #require(query.buildRun).startedAt.timeIntervalSince1970 * 1000
    func record(_ offset: Double, platform: String, slot: String = "ipad") throws -> LogRecord {
      try #require(
        LogRecord.parse(
          "{\"ts\":\(start + offset),\"src\":\"build\",\"level\":\"debug\",\"msg\":\"raw compiler flags\",\"platform\":\"\(platform)\",\"slot\":\"\(slot)\"}"
        ))
    }
    #expect(query.includes(try record(0, platform: "ios")))
    #expect(query.includes(try record(10_000, platform: "ios")))
    #expect(!query.includes(try record(-1, platform: "ios")))
    #expect(!query.includes(try record(10_001, platform: "ios")))
    #expect(!query.includes(try record(1, platform: "android")))
    #expect(!query.includes(try record(1, platform: "ios", slot: "iphone")))
    let legacy = try #require(
      LogRecord.parse(
        "{\"ts\":\(start + 1),\"src\":\"build\",\"level\":\"debug\",\"msg\":\"raw legacy compiler flags\"}"))
    #expect(query.includes(legacy))
    query.buildRun = nil
    #expect(query.params(workspace: "/app")["slot"] == .string("ipad"))
    #expect(query.params(workspace: "/app")["tail"] == .number(5000))
    #expect(query.includes(try record(-1, platform: "android")))
  }

}

@Suite struct LogEntryTests {
  struct Vectors: Decodable {
    struct View: Decodable, Equatable {
      var title: String
      var location: String?
      var codeFrame: [String]
      var details: [String]
    }

    struct Entry: Decodable, Equatable {
      var lead: Int
      var related: [Int]
      var context: [String]
      var view: View
    }

    struct GroupCase: Decodable {
      var name: String
      var records: [LogRecord]
      var entries: [Entry]
    }

    struct Frame: Decodable {
      var fn: String
      var `where`: String
      var app: Bool
    }

    struct Preview: Decodable {
      var frames: [Frame]
      var hidden: Int
      var hiddenFramework: Bool
    }

    struct PreviewCase: Decodable {
      var name: String
      var root: String
      var home: String
      var stack: [StackFrame]
      var preview: Preview?
    }

    struct PathCase: Decodable {
      var text: String
      var root: String?
      var home: String?
      var shown: String
    }

    var root: String
    var home: String
    var groups: [GroupCase]
    var previews: [PreviewCase]
    var paths: [PathCase]
  }

  static let vectors: Vectors = {
    let url = Bundle.module.url(forResource: "log-entries-vectors", withExtension: "json", subdirectory: "Fixtures")!
    return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }()

  @Test(arguments: vectors.groups.map(\.name))
  func groupsAndShowsWhatThePhoneShows(name: String) throws {
    let c = try #require(Self.vectors.groups.first { $0.name == name })
    let index = { (record: LogRecord) in c.records.firstIndex { $0.ts == record.ts && $0.msg == record.msg }! }
    var list = LogEntryList()
    list.append(c.records)
    let entries = list.entries.map { entry in
      let view = viewEntry(entry, root: Self.vectors.root, home: Self.vectors.home)
      return Vectors.Entry(
        lead: index(entry.lead), related: entry.related.map(index), context: entry.context,
        view: .init(title: view.title, location: view.location, codeFrame: view.codeFrame, details: view.details))
    }
    #expect(entries == c.entries)
    for (i, entry) in c.entries.enumerated() {
      #expect(
        ([entry.lead] + entry.related).map { list.entryIndex(ofRecord: $0) }
          == Array(repeating: i, count: entry.related.count + 1))
    }
  }

  static let stream: [LogRecord] = {
    var out: [LogRecord] = []
    for (i, c) in vectors.groups.enumerated() {
      for (j, record) in c.records.enumerated() {
        var record = record
        record.ts += Double(i) * 10_000
        out.append(record)
        if j % 3 == 1 {
          var device = record
          device.src = "device"
          device.raw = nil
          device.marker = nil
          device.event = nil
          device.msg = "device \(i) \(j)"
          out.append(device)
        }
      }
    }
    return out
  }()

  static func describe(_ entries: [LogEntry]) -> [String] {
    entries.map { e in
      ([e.lead.msg] + e.related.map(\.msg) + ["\(e.relatedBefore)"] + e.context).joined(separator: " | ")
    }
  }

  @Test(arguments: [1, 2, 3, 7, 50])
  func streamsTheSameEntriesInAnyBatchSize(size: Int) {
    var whole = LogEntryList()
    whole.append(Self.stream)
    var list = LogEntryList()
    for start in stride(from: 0, to: Self.stream.count, by: size) {
      let before = Self.describe(list.entries)
      let changed = list.append(Array(Self.stream[start..<min(start + size, Self.stream.count)]))
      #expect(Array(Self.describe(list.entries).prefix(changed)) == Array(before.prefix(changed)))
    }
    #expect(Self.describe(list.entries) == Self.describe(whole.entries))
  }

  @Test(arguments: [1, 5, 12, 20, 40])
  func dropsWholeEntriesAndKeepsTheRestAsGroupingThemAgainWould(count: Int) {
    var list = LogEntryList()
    list.append(Self.stream)
    let before = list.entries.count
    let dropped = list.dropOldest(count)
    #expect(list.records.count <= Self.stream.count - count)
    var again = LogEntryList()
    again.append(list.records)
    #expect(Self.describe(list.entries) == Self.describe(again.entries))
    #expect(before - dropped == list.entries.count)
  }

  @Test func keepsTheWidestSlotLabelWidthAfterItsRecordIsDropped() {
    var list = LogEntryList()
    var wide = Self.stream[0]
    wide.slot = "pixel-9"
    var narrow = Self.stream[1]
    narrow.slot = "a"
    list.append([narrow])
    #expect(list.slotWidth == 4)
    list.append([wide])
    #expect(list.slotWidth == 10)
    _ = list.dropOldest(2)
    #expect(list.slotWidth == 10)
  }

  @Test(arguments: vectors.previews.map(\.name))
  func previewsWhatThePhonePreviews(name: String) throws {
    let c = try #require(Self.vectors.previews.first { $0.name == name })
    let preview = stackPreview(c.stack, root: c.root, home: c.home)
    #expect(preview?.frames.map(\.fn) == c.preview?.frames.map(\.fn))
    #expect(preview?.frames.map(\.location) == c.preview?.frames.map(\.where))
    #expect(preview?.frames.map(\.app) == c.preview?.frames.map(\.app))
    #expect(preview?.hidden == c.preview?.hidden)
    #expect(preview?.hiddenFramework == c.preview?.hiddenFramework)
  }

  @Test(arguments: vectors.paths.map(\.text))
  func shortensPathsAsThePhoneDoes(text: String) throws {
    for c in Self.vectors.paths where c.text == text {
      #expect(tildeHome(relativeTo(c.text, root: c.root), home: c.home) == c.shown)
    }
  }
}
