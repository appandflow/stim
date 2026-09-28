import Foundation

/// The `build` field of a `stim status --json` environment: an `ios` or `android` run in progress.
public struct Build: Decodable, Hashable, Sendable {
  public var platform: String
  public var slot: String
  public var state: String
  public var phase: String
  public var startedAt: String
  public var phaseStartedAt: String
  public var outcome: String?
  public var expectedMs: Double?
  public var expectedPhaseMs: Double?
  public var basis: Int
  /// Present once the build tool printed a recognized line.
  public var detail: BuildDetail?
  /// Present once the run knows why the cache missed.
  public var missReason: BuildMissReason?

  public var isRunning: Bool { state == "running" }

  public func progress(at now: Date) -> BuildProgress {
    let started = parseTimestamp(startedAt) ?? now
    let elapsedMs = max(0, now.timeIntervalSince(started) * 1000)
    guard let expectedMs, expectedMs > 0 else {
      return BuildProgress(elapsedMs: elapsedMs, fraction: nil, remaining: nil)
    }
    let remainingMs = expectedMs - elapsedMs
    let remaining =
      remainingMs <= 0
      ? "longer than usual"
      : remainingMs < 60_000 ? "under a minute left" : "about \(Int((remainingMs / 60_000).rounded(.up))) min left"
    return BuildProgress(elapsedMs: elapsedMs, fraction: min(elapsedMs / expectedMs, 0.99), remaining: remaining)
  }
}

/// The build tool's step inside a build phase. `done` and `total` count `unit`s: xcodebuild `targets`, or Gradle
/// `tasks` with no total. `line` is the latest compile, link or task line.
public struct BuildDetail: Decodable, Hashable, Sendable {
  public var step: String?
  public var unit: String?
  public var done: Int?
  public var total: Int?
  public var line: String?
  public var updatedAt: String?
}

public struct BuildProgress: Equatable, Sendable {
  public var elapsedMs: Double
  /// Elapsed over the median of comparable runs, capped below 1; nil without history.
  public var fraction: Double?
  public var remaining: String?
}
