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
