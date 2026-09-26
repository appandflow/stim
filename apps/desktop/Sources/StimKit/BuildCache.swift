import Foundation

/// Where a build's app came from: `"local"` or `"remote"` in the CLI's JSON, `false` when it compiled.
public enum CacheSource: Decodable, Hashable, Sendable {
  case local
  case remote
  case none

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    switch try? container.decode(String.self) {
    case "local": self = .local
    case "remote": self = .remote
    default: self = .none
    }
  }
}

/// One platform's most recent `ios` or `android` run, from `lastBuilds` in `stim status --json`.
public struct LastBuild: Decodable, Hashable, Sendable {
  public var platform: String
  public var status: String
  public var cacheHit: CacheSource
  public var cacheSkipped: Bool?
  public var durationMs: Double?
  public var fingerprint: String?
  public var startedAt: String
  public var finishedAt: String?
  public var errorCode: String?
  public var missReason: BuildMissReason?

  public var summary: String {
    let took = durationMs.map { " in \(formatDuration(ms: $0))" } ?? ""
    guard status == "ok" else { return "Failed (\(errorCode ?? "error"))\(took)" }
    switch cacheHit {
    case .local: return "Local cache\(took)"
    case .remote: return "Remote cache\(took)"
    case .none: return "\(cacheSkipped == true ? "Compiled" : "Cache miss, compiled")\(took)"
    }
  }

  public var endedAt: Date? { parseTimestamp(finishedAt ?? startedAt) }
}

/// Why a run compiled instead of installing a cached app, from `lastBuilds.<platform>.missReason`, or why
/// the next one would, from a plan's `missReason`.
public struct BuildMissReason: Decodable, Hashable, Sendable {
  public struct Change: Decodable, Hashable, Sendable {
    public var source: String
    public var change: String
    public var category: String
  }

  public struct Baseline: Decodable, Hashable, Sendable {
    public var fingerprint: String
    public var from: String
  }

  public var kind: String
  public var summary: String
  public var changes: [Change]
  public var changeCount: Int
  public var baseline: Baseline?
  public var rekeyedBy: [String]

  public var baselineLine: String? {
    guard let baseline else { return nil }
    let place = baseline.from == "workspace" ? "in this workspace" : "of this project in another worktree"
    return "Compared with \(baseline.fingerprint.prefix(8)), the last build \(place)."
  }
}

public struct LastBuilds: Decodable, Hashable, Sendable {
  public var ios: LastBuild?
  public var android: LastBuild?

  public func build(for platform: String) -> LastBuild? { platform == "ios" ? ios : android }
}

/// The payload of `stim ios --plan --json` or `stim android --plan --json`.
public struct BuildPlan: Decodable, Hashable, Sendable {
  public var platform: String
  public var fingerprint: String
  public var cacheHit: CacheSource
  public var provider: String?
  public var cacheSkipped: Bool
  public var prebuild: String?
  public var outcome: String?
  public var expectedMs: Double?
  public var basis: Int
  public var missReason: BuildMissReason?
  public var refusal: CommandRefusal?

  /// What the next build would do, as the Builds section words it after "Next build: ".
  public var nextBuild: String {
    if let refusal { return "would refuse (\(refusal.code))" }
    let took = expectedMs.map { ", ~\(formatDuration(ms: $0))" } ?? ""
    switch cacheHit {
    case .local: return "cache hit (local)\(took)"
    case .remote: return "cache hit (remote)\(took)"
    case .none:
      let off = cacheSkipped ? " (cache reads off)" : ""
      let native = prebuild == "generate" || prebuild == "regenerate" ? ", \(prebuild!)s the native dir" : ""
      return "cold build\(off)\(native)\(took)"
    }
  }

  /// The remote provider and the runs behind the estimate.
  public var detail: String? {
    guard refusal == nil, let outcome else { return nil }
    let runs =
      expectedMs == nil
      ? "No \(outcome) run of this project recorded yet"
      : "Median of \(basis) \(outcome) run\(basis == 1 ? "" : "s")"
    return cacheHit == .remote ? "From \(provider ?? "the cache provider"). \(runs)" : runs
  }
}

/// A refusal the CLI printed as `{ code, message, remedy }`.
public struct CommandRefusal: Decodable, Error, Hashable, Sendable {
  public var code: String
  public var message: String
  public var remedy: String?
}

public enum BuildPlanOutcome: Hashable, Sendable {
  case plan(BuildPlan)
  case refused(CommandRefusal)
}

extension Build {
  /// Before prebuild, pods, compile or install, the CLI reports the outcome of the project's previous run.
  public var outcomeLabel: String? {
    guard let outcome else { return nil }
    let settled = !["prepare", "cache-lookup", "wait"].contains(phase)
    switch (outcome, settled) {
    case ("hit", true): return "Cache hit"
    case ("hit", false): return "Likely cache hit"
    case ("cold", true): return "Cold build"
    case ("cold", false): return "Likely cold"
    default: return nil
    }
  }
}
