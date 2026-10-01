import Foundation
import StimKit
import Testing

/// Replays the cases `apps/mobile/src/lib/needs-attention.test.ts` also replays, so both apps list the same items.
struct NeedsAttentionTests {
  struct Vectors: Decodable {
    struct Input: Decodable {
      var now: String
      var stuckMinutes: Int
      var easSessionMinutes: Int
      var ownLeases: [String]?
      var volumes: [Volume]?
      var environments: [Workspace]
    }

    struct Volume: Decodable { var freeBytes: Double }

    struct Case: Decodable {
      var name: String
      var input: Input
      var items: [NeedsAttentionItem]
    }

    var cases: [Case]
  }

  static let vectors: Vectors = {
    let url = Bundle.module.url(forResource: "needs-attention-vectors", withExtension: "json", subdirectory: "Fixtures")!
    return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }()

  @Test(arguments: vectors.cases.map(\.name))
  func listsWhatThePhoneLists(name: String) throws {
    let c = try #require(Self.vectors.cases.first { $0.name == name })
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let now = try #require(formatter.date(from: c.input.now))
    let items = needsAttention(
      c.input.environments, volumes: c.input.volumes?.map(\.freeBytes), now: now,
      stuckMinutes: c.input.stuckMinutes, easSessionMinutes: c.input.easSessionMinutes,
      ownLeases: c.input.ownLeases ?? [])
    #expect(items == c.items)
  }
}
