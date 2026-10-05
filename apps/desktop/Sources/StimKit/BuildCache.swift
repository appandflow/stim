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
  /// The build machine that compiled the app when the build was offloaded.
  public var offloadedTo: String?
  /// Why the run built here after it considered offloading.
  public var offloadFallback: String?
  /// The first compiler errors of a failed run; absent from an older `stim`.
  public var diagnostics: [BuildDiagnostic]?

  public var summary: String {
    let took = durationMs.map { " in \(Format.elapsed(ms: $0))" } ?? ""
    guard status == "ok" else { return "Failed (\(errorCode ?? "error"))\(took)" }
    switch cacheHit {
    case .local: return "Local cache\(took)"
    case .remote: return "Remote cache\(took)"
    case .none:
      if let offloadedTo { return "Built on \(machineName(offloadedTo))\(took)" }
      return "\(cacheSkipped == true ? "Compiled" : "Cache miss, compiled")\(took)"
    }
  }

  /// A short line for a run that considered offloading and built here, such as `janics-mac-mini busy -> built here`,
  /// from the first machine `offloadFallback` names; `reason` is the whole of it.
  public var fallbackLine: (text: String, reason: String)? {
    guard let reason = offloadFallback, !reason.isEmpty else { return nil }
    guard let match = try? Regex("^([A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?): (.+)$").wholeMatch(in: reason),
      let machine = match.output[1].substring, let rest = match.output[2].substring
    else { return ("offload skipped \u{2192} built here", reason) }
    let words: [([String], String)] = [
      (["busy"], "busy"), (["no less loaded"], "no less loaded"), (["capacity unknown"], "too old"),
      (["Stim build "], "on another Stim build"),
      (["CPU ", "Xcode ", "simulator SDK ", "CocoaPods ", "JDK "], "toolchain differs"),
      (["no iPhone simulator ", "no Android SDK", "no NDK ", "no build-tools ", "no platform "], "missing SDK"),
    ]
    let why =
      words.first { $0.0.contains { rest.hasPrefix($0) } }?.1
      ?? (rest.contains(" GB free, needs ") ? "low on disk" : "failed")
    return ("\(machineName(String(machine))) \(why) \u{2192} built here", reason)
  }

  public var endedAt: Date? { parseTimestamp(finishedAt ?? startedAt) }
}

/// One compiler error of a failed build, from `lastBuilds.<platform>.diagnostics`.
public struct BuildDiagnostic: Decodable, Hashable, Sendable {
  public var file: String?
  public var line: Int?
  public var column: Int?
  public var message: String

  /// `ios/App/AppDelegate.swift:71:24: message`, with `file` written relative to `workspace` when inside it.
  public func text(workspace: String) -> String {
    guard let file else { return message }
    let shown = file.hasPrefix(workspace + "/") ? String(file.dropFirst(workspace.count + 1)) : abbreviatingHome(file)
    let position = line.map { ":\($0)" + (column.map { ":\($0)" } ?? "") } ?? ""
    return "\(shown)\(position): \(message)"
  }
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

/// One run in a workspace's recent build history, from `builds.<platform>` in `stim status --json`: the fields
/// of a last build plus how the run ended, its slot, configuration and phase timings.
public struct BuildHistoryEntry: Decodable, Hashable, Sendable {
  public var build: LastBuild
  /// `succeeded`, `failed`, `cancelled`, or `interrupted` for a run whose process ended without a result.
  public var result: String
  public var slot: String
  public var configuration: String?
  /// Milliseconds spent in each build phase the run entered, keyed by phase name.
  public var phases: [String: Double]

  enum CodingKeys: String, CodingKey { case result, slot, configuration, phases }

  public init(from decoder: Decoder) throws {
    build = try LastBuild(from: decoder)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    result = try container.decode(String.self, forKey: .result)
    slot = try container.decode(String.self, forKey: .slot)
    configuration = try container.decodeIfPresent(String.self, forKey: .configuration)
    phases = try container.decode([String: Double].self, forKey: .phases)
  }

  /// How the run ended in a word or two, for a list row; `detail` carries the error code and miss reason.
  public var outcome: String {
    switch (result, build.cacheHit) {
    case ("interrupted", _): return "Interrupted"
    case ("cancelled", _): return "Cancelled"
    case ("failed", _): return "Failed"
    case (_, .local): return "Local cache"
    case (_, .remote): return "Remote cache"
    case (_, .none): return build.offloadedTo.map { "Built on \(machineName($0))" } ?? "Compiled"
    }
  }

  /// A list row's second line: a failed run's error code, the miss reason, and a slot other than the default.
  public var detail: String? {
    let parts = [
      result == "failed" ? build.errorCode : nil,
      build.missReason?.summary,
      slot == DeviceRef.defaultSlot ? nil : "slot \(slot)",
    ].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
  }

  /// The phases the run entered, in build order, as `compile 1m 58s \u{00B7} install 0m 3s`.
  public var phaseLine: String? {
    let order = PhaseStep.order
    let stoppedIn = stoppedPhase
    let parts = order.compactMap { phase in
      phases[phase].map { ms in phase == stoppedIn ? "stopped in \(phase)" : "\(phase) \(Format.elapsed(ms: ms))" }
    }
    return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
  }
}

public struct BuildHistory: Decodable, Hashable, Sendable {
  public var ios: [BuildHistoryEntry]?
  public var android: [BuildHistoryEntry]?

  public func builds(for platform: String) -> [BuildHistoryEntry] { (platform == "ios" ? ios : android) ?? [] }
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
    let took = expectedMs.map { ", ~\(Format.elapsed(ms: $0))" } ?? ""
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
  /// What the build card says while `missReason` is the first lookup's miss, which prebuild or pods can still turn into a hit.
  public var recheckNote: String? {
    guard missProvisional == true, missReason != nil else { return nil }
    switch phase {
    case "prebuild": return "Checks the cache again after prebuild"
    case "pods": return "Checks the cache again after pods"
    default: return "Checks the cache again after prebuild or pods"
    }
  }

  /// Until the run knows its outcome, the CLI reports the outcome of the project's previous run. An older stim sends
  /// no `outcomeKnown`; its outcome is settled from prebuild, pods, compile or install on.
  public var outcomeLabel: String? {
    guard let outcome else { return nil }
    let settled = outcomeKnown ?? !["prepare", "cache-lookup", "wait", "device"].contains(phase)
    guard settled else { return nil }
    switch outcome {
    case "hit": return "Cache hit"
    case "cold": return missReason == nil ? "Cold build" : "Cache miss"
    default: return nil
    }
  }
}
