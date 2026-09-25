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

  public var summary: String {
    let took = durationMs.map { " in \(formatDuration(ms: $0))" } ?? ""
    guard status == "ok" else { return "Failed (\(errorCode ?? "error"))\(took)" }
    switch cacheHit {
    case .local: return "Local cache\(took)"
    case .remote: return "Remote cache\(took)"
    case .none: return "Compiled\(took)"
    }
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
  public var refusal: CommandRefusal?

  public var summary: String {
    if let refusal { return "Would refuse: \(refusal.code)" }
    switch cacheHit {
    case .local: return "Local cache hit"
    case .remote: return "Remote cache hit (\(provider ?? "provider"))"
    case .none:
      let why = cacheSkipped ? "Cache reads off" : "Cache miss"
      let native = prebuild == "generate" || prebuild == "regenerate" ? ", \(prebuild!)s the native dir" : ""
      return "\(why): compiles\(native)"
    }
  }

  public var expectation: String? {
    guard refusal == nil, let outcome else { return nil }
    guard let expectedMs else { return "No \(outcome) run of this project recorded yet" }
    return "~\(formatDuration(ms: expectedMs)), median of \(basis) \(outcome) run\(basis == 1 ? "" : "s")"
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
