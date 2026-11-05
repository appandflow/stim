import Foundation
import StimKit
import Testing

/// Replays the cases `apps/mobile/src/lib/logs.test.ts` also replays, so both apps keep and filter the same actions.
struct AgentActionsTests {
  struct Vectors: Decodable {
    struct Batch: Decodable {
      var records: [LogRecord]
      var ts: [Double]
      var keys: [Int]
    }

    struct Append: Decodable {
      var name: String
      var deviceId: String
      var max: Int
      var batches: [Batch]
    }

    struct Option: Decodable {
      var label: String
      var count: Int
      var ts: [Double]
    }

    struct Filters: Decodable {
      var name: String
      var records: [LogRecord]
      var options: [Option]
    }

    var append: [Append]
    var filters: [Filters]
  }

  static let vectors: Vectors = {
    let url = Bundle.module.url(forResource: "agent-actions-vectors", withExtension: "json", subdirectory: "Fixtures")!
    return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }()

  @Test(arguments: vectors.append.map(\.name))
  func keepsWhatThePhoneKeeps(name: String) throws {
    let c = try #require(Self.vectors.append.first { $0.name == name })
    var actions: [AgentAction] = []
    for batch in c.batches {
      actions = AgentAction.appending(batch.records, to: actions, deviceID: c.deviceId, max: c.max)
      #expect(actions.map(\.record.ts) == batch.ts)
      #expect(actions.map(\.key) == batch.keys)
    }
  }

  @Test(arguments: vectors.filters.map(\.name))
  func offersWhatThePhoneOffers(name: String) throws {
    let c = try #require(Self.vectors.filters.first { $0.name == name })
    let actions = c.records.enumerated().map { AgentAction(key: $0.offset, record: $0.element) }
    let options = AgentFilter.options(actions)
    #expect(options.map(\.label) == c.options.map(\.label))
    #expect(options.map(\.count) == c.options.map(\.count))
    for (option, expected) in zip(options, c.options) {
      #expect(actions.filter(option.filter.matches).map(\.record.ts) == expected.ts)
    }
  }
}

@Suite struct AgentActionListTests {
  /// Newest first, as `AgentAction.appending` keeps them: keys 1 to 4 at 10s, 20s, 30s and 20 minutes, key 3 failed.
  static let actions: [AgentAction] = [
    action(4, ts: 1_200_000, command: "scroll"),
    action(3, ts: 30_000, command: "press", level: "error"),
    action(2, ts: 20_000, command: "press"),
    action(1, ts: 10_000, command: "open"),
  ]

  static func action(_ key: Int, ts: Double, command: String, level: String = "info", startedAt: Double? = nil)
    -> AgentAction
  {
    let started = startedAt.map { #","startedAt":\#(Int($0))"# } ?? ""
    let line =
      #"{"ts":\#(Int(ts)),"src":"agent","level":"\#(level)","msg":"\#(command)","command":"\#(command)","deviceId":"D"\#(started)}"#
    return AgentAction(key: key, record: LogRecord.parse(line)!)
  }

  @Test func listsOldestFirstWithAGapRowBeforeALongPause() {
    let rows = AgentActionList(Self.actions).rows.map { row -> String in
      switch row {
      case .gap(let ms, let before): return "gap \(Int(ms)) before \(before)"
      case .action(let action): return "\(action.key)"
      }
    }
    #expect(rows == ["1", "2", "3", "gap 1170000 before 4", "4"])
    #expect(AgentActionList(Self.actions, filter: .failed).actions.map(\.key) == [3])
  }

  @Test func placesAnActionAtItsStartLikeItsReplayMarker() {
    #expect(Self.action(1, ts: 12_000, command: "fill", startedAt: 9_000).at == 9_000)
    #expect(Self.action(1, ts: 12_000, command: "fill").at == 12_000)
  }

  @Test func highlightsTheNewestWhileLiveAndTheLastShownWhileReplaying() {
    let list = AgentActionList(Self.actions)
    #expect(list.current(live: true, at: nil, stepped: nil) == 4)
    #expect(list.current(live: false, at: 25_000, stepped: nil) == 2)
    #expect(list.current(live: false, at: 30_000, stepped: nil) == 3)
    #expect(list.current(live: false, at: 5_000, stepped: nil) == nil)
    #expect(list.current(live: false, at: nil, stepped: nil) == nil)
    #expect(AgentActionList([]).current(live: true, at: nil, stepped: nil) == nil)
  }

  @Test func highlightsTheActionClickedEvenThoughTheSeekLandsBeforeIt() {
    let list = AgentActionList(Self.actions)
    #expect(list.current(live: false, at: 28_500, stepped: 30_000) == 3)
    #expect(list.current(live: false, at: nil, stepped: 30_000) == 3)
    #expect(list.current(live: false, at: 1_300_000, stepped: 30_000) == 4)
  }

  @Test func highlightsOnlyWhatTheFilterShows() {
    let failed = AgentActionList(Self.actions, filter: .failed)
    #expect(failed.current(live: false, at: 25_000, stepped: nil) == nil)
    #expect(failed.current(live: false, at: 1_300_000, stepped: nil) == 3)
    #expect(failed.current(live: true, at: nil, stepped: nil) == 3)
  }

  @Test func movesThroughTheListAndStopsAtEitherEnd() {
    let list = AgentActionList(Self.actions)
    #expect(list.adjacent(to: 2, forward: true)?.key == 3)
    #expect(list.adjacent(to: 2, forward: false)?.key == 1)
    #expect(list.adjacent(to: 4, forward: true) == nil)
    #expect(list.adjacent(to: 1, forward: false) == nil)
    #expect(list.adjacent(to: nil, forward: true)?.key == 1)
    #expect(list.adjacent(to: nil, forward: false)?.key == 4)
    #expect(AgentActionList(Self.actions, filter: .failed).adjacent(to: 2, forward: true)?.key == 3)
  }
}
