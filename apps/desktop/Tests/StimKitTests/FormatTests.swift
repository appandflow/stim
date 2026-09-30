import Foundation
import StimKit
import Testing

/// Replays the cases `apps/mobile/src/intl/format.test.ts` also replays, so both apps word a figure the same.
struct FormatTests {
  struct Vectors: Decodable {
    struct Milliseconds: Decodable {
      var ms: Double
      var text: String
    }

    struct Megabytes: Decodable {
      var mb: Double
      var text: String
    }

    struct Bytes: Decodable {
      var bytes: Double
      var text: String
    }

    var duration: [Milliseconds]
    var since: [Milliseconds]
    var roundedDuration: [Milliseconds]
    var clock: [Milliseconds]
    var memoryMb: [Megabytes]
    var bytes: [Bytes]
  }

  static let vectors: Vectors = {
    let url = Bundle.module.url(forResource: "format-vectors", withExtension: "json", subdirectory: "Fixtures")!
    return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }()

  @Test func wordsDurationsAsThePhoneDoes() {
    for c in Self.vectors.duration { #expect(Format.duration(c.ms / 1000) == c.text, "\(c.ms) ms") }
    for c in Self.vectors.since { #expect(Format.since(c.ms / 1000) == c.text, "\(c.ms) ms") }
    for c in Self.vectors.roundedDuration { #expect(Format.roundedDuration(ms: c.ms) == c.text, "\(c.ms) ms") }
    for c in Self.vectors.clock { #expect(Format.clock(ms: c.ms) == c.text, "\(c.ms) ms") }
  }

  @Test func wordsSizesAsThePhoneDoes() {
    for c in Self.vectors.memoryMb { #expect(Format.memoryMb(c.mb) == c.text, "\(c.mb) MB") }
    for c in Self.vectors.bytes { #expect(Format.freeSpace(c.bytes) == c.text, "\(c.bytes) bytes") }
  }

  @Test func fileSizeUsesDecimalUnitsAndSpellsZero() {
    #expect(Format.fileSize(0) == "0 bytes")
    #expect(Format.fileSize(1_500_000_000) == "1.5 GB")
    #expect(Format.fileSize(999) == "999 bytes")
  }

  @Test func memoryUsesBinaryUnits() {
    #expect(Format.memory(16 * 1_073_741_824) == "16 GB")
  }

  @Test func gigabytesAlwaysShowOneDecimal() {
    #expect(Format.gigabytes(mb: 0) == "0.0 GB")
    #expect(Format.gigabytes(mb: 1536) == "1.5 GB")
    #expect(Format.gigabytes(mb: 16 * 1024) == "16.0 GB")
  }

  @Test func memoryPairShowsUsedOverTotal() {
    let gib: Int64 = 1_073_741_824
    #expect(Format.memoryPair(usedBytes: 7 * gib + gib / 2, totalBytes: 16 * gib) == "7.5/16 GB")
  }

  @Test func elapsedSpellsMinutesAndSecondsThenHours() {
    #expect([0.0, 59_000, 65_000, 3_599_000].map(Format.elapsed(ms:)) == ["0m 0s", "0m 59s", "1m 5s", "59m 59s"])
    #expect([3_600_000.0, 3_720_000].map(Format.elapsed(ms:)) == ["1h 0m", "1h 2m"])
  }

  @Test func ageWordsUnderAMinuteAsJustNow() {
    #expect([-30.0, 0, 59].map(Format.age) == ["just now", "just now", "just now"])
    #expect([60.0, 3599, 3600, 90_000].map(Format.age) == ["1m ago", "59m ago", "1h ago", "25h ago"])
  }

  @Test func simulatorModelTakesTheLastParenthesizedGroup() {
    #expect(Format.simulatorModel("stim-app (iPhone 17 Pro iOS 26.0)") == "iPhone 17 Pro iOS 26.0")
    #expect(Format.simulatorModel("stim-app (a) (iPad (10th generation))") == "iPad (10th generation)")
    #expect(Format.simulatorModel("stim-app (iPhone 17)  ") == "iPhone 17")
    #expect(Format.simulatorModel("stim-app") == "iOS Simulator")
    #expect(Format.simulatorModel(nil) == "iOS Simulator")
  }
}
