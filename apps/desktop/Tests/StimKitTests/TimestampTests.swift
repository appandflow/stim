import Foundation
import Testing

@testable import StimKit

@Suite struct TimestampTests {
  @Test func parsesServerMillisecondsAndLegacyTimestampShapes() throws {
    let cases: [(String, Double)] = [
      ("1970-01-01T00:00:00.123Z", 0.123),
      ("2026-10-29T13:01:00.012Z", 1793278860.012),
      ("1970-01-01T00:00:00Z", 0),
      ("1970-01-01T00:00:00.1Z", 0.1),
      ("1970-01-01T00:00:00.123456Z", 0.123),
      ("1970-01-01T01:00:00.123+01:00", 0.123),
      ("1969-12-31T19:00:00-05:00", 0),
      ("2000-02-29T00:00:00.000Z", 951782400),
    ]
    for (text, expected) in cases {
      let date = try #require(parseTimestamp(text))
      #expect(abs(date.timeIntervalSince1970 - expected) < 0.000_01, "\(text)")
    }
    for text in ["", "not-a-date", "2026-10-29T13:01:00.abcZ", "2026-10-29T13:01:00.012"] {
      #expect(parseTimestamp(text) == nil, "\(text)")
    }
  }

  @Test func parsesIndependentTimestampsConcurrently() async {
    let success = await withTaskGroup(of: Bool.self) { group in
      for seconds in 0..<60 {
        group.addTask {
          let text = String(format: "1970-01-01T00:00:%02d.125Z", seconds)
          guard let date = parseTimestamp(text) else { return false }
          return abs(date.timeIntervalSince1970 - Double(seconds) - 0.125) < 0.000_01
        }
      }
      return await group.reduce(true) { $0 && $1 }
    }
    #expect(success)
  }
}
