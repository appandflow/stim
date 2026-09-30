import Foundation
import StimKit
import Testing

struct FormatTests {
  @Test func fileSizeUsesDecimalUnitsAndSpellsZero() {
    #expect(Format.fileSize(0) == "0 bytes")
    #expect(Format.fileSize(1_500_000_000) == "1.5 GB")
    #expect(Format.fileSize(999) == "999 bytes")
  }

  @Test func memoryUsesBinaryUnits() {
    #expect(Format.memory(16 * 1_073_741_824) == "16 GB")
    #expect(Format.memoryMb(512) == "512 MB")
    #expect(Format.memoryMb(1024) == "1.0 GB")
    #expect(Format.memoryMb(1536) == "1.5 GB")
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

  @Test func freeSpaceRoundsTiesUpAndDropsDecimalsFromOneHundredGb() {
    #expect(Format.freeSpace(1.25e9) == "1.3 GB")
    #expect(Format.freeSpace(1.24e9) == "1.2 GB")
    #expect(Format.freeSpace(99.96e9) == "100.0 GB")
    #expect(Format.freeSpace(100.4e9) == "100 GB")
    #expect(Format.freeSpace(412.6e9) == "413 GB")
    #expect(Format.freeSpace(1.25e12) == "1.3 TB")
  }

  @Test func durationTruncatesAndRollsOverAtHoursAndDays() {
    #expect([0.0, 59, 60, 719, 3599].map(Format.duration) == ["<1m", "<1m", "1m", "11m", "59m"])
    #expect([3600.0, 3660, 5400, 86_399].map(Format.duration) == ["1h", "1h01m", "1h30m", "23h59m"])
    #expect([86_400.0, 176_400.0].map(Format.duration) == ["1d", "2d"])
    #expect(Format.duration(-300) == "<1m")
  }

  @Test func sinceShowsSecondsUnderAMinute() {
    #expect([-5.0, 0, 12.9, 59.9].map(Format.since) == ["0s", "0s", "12s", "59s"])
    #expect([60.0, 3700].map(Format.since) == ["1m", "1h01m"])
  }

  @Test func roundedDurationRoundsAndKeepsHoursUntilTwoDays() {
    #expect([-1000.0, 0, 40_000, 59_400].map(Format.roundedDuration(ms:)) == ["0s", "0s", "40s", "59s"])
    #expect([60_000.0, 840_000.0, 3_570_000.0].map(Format.roundedDuration(ms:)) == ["1m", "14m", "1h"])
    #expect([169_200_000.0, 172_800_000.0, 259_200_000.0].map(Format.roundedDuration(ms:)) == ["47h", "2d", "3d"])
  }

  @Test func clockPadsSeconds() {
    #expect([-5000.0, 0, 5000, 158_000, 3_600_000].map(Format.clock(ms:)) == ["0:00", "0:00", "0:05", "2:38", "60:00"])
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
