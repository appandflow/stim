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
  /// Whether `outcome` is this run's own rather than the project's latest; nil from an older stim.
  public var outcomeKnown: Bool?
  public var expectedMs: Double?
  public var expectedPhaseMs: Double?
  public var basis: Int
  /// The phases runs like this one go through, in order, with each one's median, from the runs behind `expectedMs`;
  /// nil without such runs or from an older stim.
  public var plannedPhases: [PlannedPhase]?
  /// Present once the build tool printed a recognized line; a current stim sends it only during `compile`.
  public var detail: BuildDetail?
  /// Present once the run knows why the cache missed.
  public var missReason: BuildMissReason?
  /// True while `missReason` is the first lookup's miss and the run looks the key up again after prebuild or pods.
  public var missProvisional: Bool?
  /// Where it compiles; nil from a `stim` older than build offload.
  public var placement: BuildPlacement?
  /// While `phase` is `wait`: the workspace whose build of the same artifact this run waits for; nil from an older stim
  /// or when the holder is not known.
  public var waitingOn: WaitingOn?

  public var isRunning: Bool { state == "running" }

  /// Identifies one run: a new run in the same slot has a new `startedAt`.
  public var key: String { "\(platform)|\(slot)|\(startedAt)" }

  /// The build machine this build was offloaded to and the step it runs there; nil for a local build.
  public func remote(at now: Date) -> RemoteBuild? {
    guard case .remote(let host, let step, _, let stepStartedAt) = placement else { return nil }
    return RemoteBuild(
      host: machineName(host), phase: RemoteBuild.phaseName(step),
      phaseElapsedMs: parseTimestamp(stepStartedAt).map { max(0, now.timeIntervalSince($0) * 1000) })
  }

  public var startedDate: Date? { parseTimestamp(startedAt) }

  public func progress(at now: Date) -> BuildProgress {
    let started = startedDate ?? now
    let elapsedMs = max(0, now.timeIntervalSince(started) * 1000)
    guard let expectedMs, expectedMs > 0 else {
      return BuildProgress(elapsedMs: elapsedMs, fraction: nil, remaining: nil)
    }
    let remainingMs = expectedMs - elapsedMs
    let remaining =
      remainingMs <= 0
      ? "longer than usual"
      : remainingMs < 60_000 ? "under a minute left" : "about \(Int((remainingMs / 60_000).rounded(.up))) min left"
    let fraction = steadyFraction("\(key)|top", min(elapsedMs / expectedMs, 0.99))
    return BuildProgress(elapsedMs: elapsedMs, fraction: fraction, remaining: remaining)
  }
}

public struct WaitingOn: Decodable, Hashable, Sendable {
  public var path: String
}

public struct PlannedPhase: Decodable, Hashable, Sendable {
  public var phase: String
  public var expectedMs: Double
}

private final class ShownFractions: @unchecked Sendable {
  static let limit = 64
  private let lock = NSLock()
  private var values: [String: Double] = [:]
  private var order: [String] = []

  func steady(_ key: String, _ fraction: Double) -> Double {
    lock.lock()
    defer { lock.unlock() }
    let value = max(values[key] ?? 0, fraction)
    values[key] = value
    order.removeAll { $0 == key }
    order.append(key)
    if order.count > Self.limit { values[order.removeFirst()] = nil }
    return value
  }
}

private let shownFractions = ShownFractions()

/// The larger of `fraction` and the largest one returned for `key` so far, so a bar never moves backwards.
public func steadyFraction(_ key: String, _ fraction: Double) -> Double {
  shownFractions.steady(key, fraction)
}

/// `local`, or the build machine a build was offloaded to (its `offload.machines` entry), the step it runs there
/// (`sync`, `deps`, `prebuild`, `pods`, `build` or `fetch`) and when the offload and that step started.
public enum BuildPlacement: Decodable, Hashable, Sendable {
  case local
  case remote(host: String, phase: String, startedAt: String, phaseStartedAt: String)

  private enum CodingKeys: String, CodingKey { case host, phase, startedAt, phaseStartedAt }

  public init(from decoder: Decoder) throws {
    if (try? decoder.singleValueContainer().decode(String.self)) != nil {
      self = .local
      return
    }
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self = .remote(
      host: try container.decode(String.self, forKey: .host), phase: try container.decode(String.self, forKey: .phase),
      startedAt: try container.decode(String.self, forKey: .startedAt),
      phaseStartedAt: try container.decode(String.self, forKey: .phaseStartedAt))
  }
}

/// A running build on a build machine: the machine's name, the step it runs there and how long that step has run.
public struct RemoteBuild: Equatable, Sendable {
  public var host: String
  public var phase: String
  public var phaseElapsedMs: Double?

  static func phaseName(_ step: String) -> String {
    let names = [
      "sync": "Sync", "deps": "Dependencies", "prebuild": "Prebuild", "pods": "Pods", "build": "Compile",
      "fetch": "Download",
    ]
    return names[step] ?? step.prefix(1).uppercased() + step.dropFirst()
  }
}

/// A build machine's `offload.machines` entry without its `:port`.
public func machineName(_ entry: String) -> String {
  guard let colon = entry.lastIndex(of: ":"), entry[entry.index(after: colon)...].allSatisfy(\.isNumber),
    colon != entry.index(before: entry.endIndex)
  else { return entry }
  return String(entry[..<colon])
}

/// The build tool's step inside a build phase. `done` and `total` count `unit`s: xcodebuild `targets` it finished
/// (started, from an older stim), or Gradle `tasks` with no total. `line` is the latest compile, link or task line.
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
  /// Elapsed over the median of comparable runs, capped below 1, and never below what it was for the same build
  /// before the run revised its estimate; nil without history.
  public var fraction: Double?
  public var remaining: String?
}
