import Foundation

extension GcReport {
  /// One process of the memory report: the shared watchman daemon, or a Gradle or Kotlin daemon.
  public struct MemoryProcess: Decodable, Hashable, Sendable {
    /// `watchman`, `gradleDaemon` or `kotlinDaemon`.
    public var kind: String
    /// The `stim gc --cache` argument that acts on it: `watchman` or `gradle-daemons`.
    public var cacheKind: String
    public var pid: Int
    public var bytes: Int64?
    /// Whether `stim gc --delete --cache <cacheKind>` would stop it.
    public var reclaimable: Bool
    public var reason: String?
    public var detail: String?

    public init(
      kind: String, cacheKind: String, pid: Int, bytes: Int64? = nil, reclaimable: Bool, reason: String? = nil,
      detail: String? = nil
    ) {
      self.kind = kind
      self.cacheKind = cacheKind
      self.pid = pid
      self.bytes = bytes
      self.reclaimable = reclaimable
      self.reason = reason
      self.detail = detail
    }
  }

  public struct WatchmanRoot: Decodable, Hashable, Sendable {
    public var path: String
    /// Whether `--cache watchman` removes this stale root.
    public var removable: Bool
    public var detail: String?

    public init(path: String, removable: Bool, detail: String? = nil) {
      self.path = path
      self.removable = removable
      self.detail = detail
    }
  }

  public struct MemoryNotice: Decodable, Hashable, Sendable {
    public var message: String

    public init(message: String) {
      self.message = message
    }
  }

  /// What the Processes table offers for one of its rows: a run of `stim gc --delete --cache <cacheKind>`,
  /// or the reason gc keeps the process.
  public struct MemoryReclaim: Equatable, Sendable {
    public enum Availability: Equatable, Sendable {
      case available
      case unavailable(String)
    }

    public var cacheKind: String
    public var availability: Availability
    /// How many processes the run would stop, and their footprint.
    public var stops: Int
    public var bytes: Int64
    /// Stale watchman roots the run would remove.
    public var staleRoots: Int
    /// Why gc keeps the other processes of this row, when it stops some.
    public var keptReasons: [String]

    public var isAvailable: Bool { availability == .available }

    /// "Reclaim memory", or "Remove stale roots" when the run frees no process memory.
    public var title: String { stops > 0 || staleRoots == 0 ? "Reclaim memory" : "Remove stale roots" }

    public var unavailableReason: String? {
      if case .unavailable(let reason) = availability { return reason }
      return nil
    }

    /// The run, from `cwd`: `stim gc --delete --json --cache <cacheKind>`. gc re-checks every process before it acts.
    public func command(cwd: String) -> StimCommand {
      StimCommand(["gc", "--delete", "--json", "--cache", cacheKind], cwd: cwd)
    }

    /// What the confirmation says the run does.
    public var consequence: String {
      let watchman = cacheKind == "watchman"
      var lines: [String] = []
      if stops > 0 {
        let size = bytes > 0 ? " to free \(Format.memory(bytes))" : ""
        lines.append(
          watchman
            ? "Shuts down the watchman daemon\(size). Metro starts it again when it needs it."
            : "Stops the idle Gradle and Kotlin daemons\(size). The next build starts a new daemon.")
      }
      if staleRoots > 0 {
        lines.append("Removes \(staleRoots == 1 ? "1 stale watchman root" : "\(staleRoots) stale watchman roots").")
      }
      lines.append(
        "stim gc checks again right before it acts and keeps anything it cannot prove unused"
          + (keptReasons.isEmpty ? "." : ": \(keptReasons.joined(separator: "; ")).")
      )
      return lines.joined(separator: "\n\n")
    }

    /// The memory kind a Processes row stands for, or nil for a row this action does not cover.
    static func processKind(of owner: MachineOwner) -> String? {
      guard owner.kind == .shared else { return nil }
      switch owner.name {
      case "Watchman": return "watchman"
      case "Gradle daemon": return "gradleDaemon"
      case "Kotlin daemon": return "kotlinDaemon"
      default: return nil
      }
    }
  }

  /// The reclaim offer for a Processes row from this report, or nil when the row is not Watchman or a Gradle or
  /// Kotlin daemon. The Gradle and Kotlin rows share one offer, because `--cache gradle-daemons` acts on both. Pass a nil `report` while gc has not answered yet.
  public static func reclaim(for owner: MachineOwner, in report: GcReport?) -> MemoryReclaim? {
    guard let kind = MemoryReclaim.processKind(of: owner) else { return nil }
    let cacheKind = kind == "watchman" ? "watchman" : "gradle-daemons"
    func unavailable(_ reason: String) -> MemoryReclaim {
      MemoryReclaim(cacheKind: cacheKind, availability: .unavailable(reason), stops: 0, bytes: 0, staleRoots: 0, keptReasons: [])
    }
    guard let report else { return unavailable("Waiting for stim gc to report what it can stop.") }
    guard let memory = report.sections.memory else {
      return unavailable("This stim does not report memory it can reclaim. Update stim.")
    }
    let processes = memory.filter { $0.cacheKind == cacheKind }
    let roots = kind == "watchman" ? (report.sections.watchmanRoots ?? []).filter(\.removable).count : 0
    let stopped = processes.filter(\.reclaimable)
    var reasons: [String] = []
    for process in processes where !process.reclaimable {
      let reason = process.detail ?? process.reason ?? "it could not be proven unused"
      if !reasons.contains(reason) { reasons.append(reason) }
    }
    if stopped.isEmpty && roots == 0 {
      if !reasons.isEmpty { return unavailable("Kept: " + reasons.joined(separator: "; ")) }
      let notice = report.sections.memoryNotices?.first?.message
      return unavailable(notice ?? "stim gc found no \(owner.name) process it can inspect.")
    }
    return MemoryReclaim(
      cacheKind: cacheKind, availability: .available, stops: stopped.count, bytes: stopped.compactMap(\.bytes).reduce(0, +),
      staleRoots: roots,
      keptReasons: reasons)
  }
}
