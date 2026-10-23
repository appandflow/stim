import Foundation

/// One native build run of `stim logs --source builds --json`. Fields newer than this app are ignored.
public struct LedgerBuild: Decodable, Hashable, Identifiable, Sendable {
  public enum Outcome: String, Decodable, CaseIterable, Sendable {
    case succeeded, failed, cancelled

    public init(from decoder: Decoder) throws {
      let raw = try decoder.singleValueContainer().decode(String.self)
      self = Outcome(rawValue: raw) ?? .failed
    }

    public var title: String {
      switch self {
      case .succeeded: return "Succeeded"
      case .failed: return "Failed"
      case .cancelled: return "Cancelled"
      }
    }
  }

  public struct Placement: Decodable, Hashable, Sendable {
    /// `local` or `offloaded`.
    public var `where`: String
    public var machine: String?
    public var fellBack: Bool?
    public var reason: String?
  }

  public struct Cache: Decodable, Hashable, Sendable {
    /// `hit`, `miss` or `bypassed`.
    public var result: String
    /// `local` or `remote` for a hit.
    public var source: String?
    public var key: String?
    public var fingerprint: String?
    public var missReason: String?
  }

  public struct Failure: Decodable, Hashable, Sendable {
    public var code: String?
    public var message: String?
    public var remedy: String?
    public var phase: String?
  }

  public struct Device: Decodable, Hashable, Sendable {
    public var name: String
    public var runtime: String?
  }

  public var id: String
  /// Epoch milliseconds when the run finished and when it started.
  public var ts: Double
  public var startedAt: Double
  public var project: String
  public var workspace: String
  public var branch: String?
  /// `ios`, `android` or `macos`.
  public var platform: String
  public var scheme: String?
  public var variant: String?
  public var configuration: String?
  public var placement: Placement
  public var cache: Cache
  public var durationMs: Double
  public var phases: [String: Double]
  public var offloadPhases: [String: Double]?
  public var outcome: Outcome
  public var failure: Failure?
  public var device: Device?
  public var stimVersion: String?

  public var date: Date { Date(timeIntervalSince1970: ts / 1000) }
  public var startedDate: Date { Date(timeIntervalSince1970: startedAt / 1000) }

  /// The build machine that compiled the app; nil for a build on this Mac.
  public var machine: String? { placement.where == "offloaded" ? placement.machine : nil }

  public var projectName: String {
    URL(fileURLWithPath: project).lastPathComponent
  }

  public var platformTitle: String {
    switch platform {
    case "ios": return "iOS"
    case "android": return "Android"
    case "macos": return "macOS"
    default: return platform
    }
  }

  /// The build machine's name, "This Mac (fell back)" for a build that considered offloading, or "This Mac".
  public var whereText: String {
    if let machine { return machine }
    return placement.fellBack == true ? "This Mac (fell back)" : "This Mac"
  }

  public var cacheText: String {
    switch cache.result {
    case "hit": return cache.source == "remote" ? "Remote cache hit" : "Cache hit"
    case "bypassed": return "Cache bypassed"
    default: return "Cache miss"
    }
  }

  /// The scheme, variant or configuration the build used.
  public var target: String? { scheme ?? variant ?? configuration }

  public var durationText: String { Format.elapsed(ms: durationMs) }
}

/// One bar of a build's timeline.
public struct LedgerPhase: Identifiable, Hashable, Sendable {
  public enum Lane: Hashable, Sendable {
    case local
    case machine(String)
  }

  public var id: String
  public var lane: Lane
  public var name: String
  public var title: String
  public var ms: Double
  /// The phase the run was in when it failed.
  public var failed: Bool
}

extension LedgerBuild {
  private static let localOrder = [
    "prepare", "cache-lookup", "wait", "prebuild", "pods", "compile", "device", "install", "launch",
  ]
  private static let machineOrder = ["sync", "deps", "prebuild", "pods", "build", "fetch"]

  private static let titles: [String: String] = [
    "prepare": "Prepare", "cache-lookup": "Cache lookup", "wait": "Waiting for another build",
    "prebuild": "Prebuild", "pods": "CocoaPods", "compile": "Compile", "device": "Device",
    "install": "Install", "launch": "Launch", "sync": "Sync", "deps": "Dependencies", "build": "Build",
    "fetch": "Fetch",
  ]

  /// The phases of the run in the order they happen: this Mac's, then the build machine's, which ran
  /// inside the local compile phase. A phase with no time is left out.
  public var timeline: [LedgerPhase] {
    var out = Self.segments(phases, order: Self.localOrder, lane: .local, failedPhase: failure?.phase)
    if let offloadPhases, let machine {
      out += Self.segments(
        offloadPhases, order: Self.machineOrder, lane: .machine(machine), failedPhase: nil)
    }
    return out
  }

  private static func segments(
    _ phases: [String: Double], order: [String], lane: LedgerPhase.Lane, failedPhase: String?
  ) -> [LedgerPhase] {
    let known = order.filter { phases[$0] != nil }
    let unknown = phases.keys.filter { !order.contains($0) }.sorted()
    let prefix: String
    switch lane {
    case .local: prefix = "local"
    case .machine(let name): prefix = "machine:\(name)"
    }
    return (known + unknown).compactMap { name in
      guard let ms = phases[name], ms > 0 else { return nil }
      return LedgerPhase(
        id: "\(prefix):\(name)", lane: lane, name: name, title: titles[name] ?? name, ms: ms,
        failed: lane == .local && name == failedPhase)
    }
  }
}

/// The history's filters; nil shows every project, platform, machine or outcome.
public struct LedgerFilter: Equatable, Sendable {
  /// The machine filter value for builds that ran on this Mac.
  public static let thisMac = ""

  public var project: String?
  public var platform: String?
  /// A build machine's name, or `thisMac`.
  public var machine: String?
  public var outcome: LedgerBuild.Outcome?

  public init(
    project: String? = nil, platform: String? = nil, machine: String? = nil,
    outcome: LedgerBuild.Outcome? = nil
  ) {
    self.project = project
    self.platform = platform
    self.machine = machine
    self.outcome = outcome
  }

  public func matches(_ item: LedgerBuild) -> Bool {
    (project == nil || item.project == project) && (platform == nil || item.platform == platform)
      && (machine == nil || (item.machine ?? Self.thisMac) == machine)
      && (outcome == nil || item.outcome == outcome)
  }
}

public enum BuildLedger {
  /// Parses `stim logs --source builds --json`: newest build first, lines that are not build records skipped, a
  /// repeated build kept once.
  public static func parse(_ output: Data) -> [LedgerBuild] {
    var seen = Set<String>()
    let items = String(decoding: output, as: UTF8.self).split(separator: "\n").compactMap { line -> LedgerBuild? in
      guard let item = try? JSONDecoder().decode(LedgerBuild.self, from: Data(line.utf8)) else { return nil }
      return seen.insert(item.id).inserted ? item : nil
    }
    return items.sorted { $0.ts > $1.ts }
  }

  /// The builds the filter shows, grouped by local day, newest first.
  public static func days(
    _ items: [LedgerBuild], _ filter: LedgerFilter = LedgerFilter(), calendar: Calendar = .current
  ) -> [(day: Date, items: [LedgerBuild])] {
    var out: [(day: Date, items: [LedgerBuild])] = []
    for item in items where filter.matches(item) {
      let day = calendar.startOfDay(for: item.date)
      if out.last?.day == day {
        out[out.count - 1].items.append(item)
      } else {
        out.append((day, [item]))
      }
    }
    return out
  }

  /// The builds that ran on the build machine a `remote.machines` entry names, newest first when `items` is.
  public static func items(on entry: String, in items: [LedgerBuild]) -> [LedgerBuild] {
    let name = OffloadMachines.name(entry)
    return items.filter { $0.machine.map(OffloadMachines.name) == name }
  }

  public struct ProjectChoice: Hashable, Sendable {
    public var path: String
    /// The project's folder name, with its parent folder when another project has the same name.
    public var title: String
  }

  public struct Choices: Equatable, Sendable {
    public var projects: [ProjectChoice]
    public var platforms: [String]
    public var machines: [String]
  }

  /// What the filters can choose from: the projects, platforms and machines the history has builds of.
  public static func choices(_ items: [LedgerBuild]) -> Choices {
    var paths: [String] = []
    for item in items where !paths.contains(item.project) { paths.append(item.project) }
    let names = paths.map { URL(fileURLWithPath: $0).lastPathComponent }
    var projects: [ProjectChoice] = []
    for (path, name) in zip(paths, names) {
      let parent = URL(fileURLWithPath: path).deletingLastPathComponent().lastPathComponent
      let clash = names.filter { $0 == name }.count > 1
      projects.append(ProjectChoice(path: path, title: clash ? "\(name) (\(parent))" : name))
    }
    projects.sort { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    return Choices(
      projects: projects, platforms: Array(Set(items.map(\.platform))).sorted(),
      machines: Array(Set(items.compactMap(\.machine))).sorted())
  }
}

extension StimCLI {
  public func buildLedger(limit: Int = 500) async throws -> [LedgerBuild] {
    BuildLedger.parse(try await run(["logs", "--source", "builds", "--json", "--tail", String(limit)], cwd: NSHomeDirectory()))
  }
}
