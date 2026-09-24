import Foundation

/// The dry-run report printed by `stim gc --json`, reduced to what a person
/// reviews before `stim gc --delete`.
public struct GcPreview: Sendable {
  public struct Entry: Hashable, Sendable {
    public var label: String
    public var bytes: Int64?
    /// Why `--delete` leaves this entry alone, or nil when it acts on it.
    public var kept: String?
  }

  public struct Section: Hashable, Sendable {
    public var key: String
    public var title: String
    public var entries: [Entry]
  }

  public enum Failure: LocalizedError {
    case refused(message: String, remedy: String?)
    case unreadable

    public var errorDescription: String? {
      switch self {
      case .refused(let message, let remedy): return [message, remedy].compactMap { $0 }.joined(separator: " ")
      case .unreadable: return "stim gc --json did not print a report."
      }
    }
  }

  public var actionable: Bool
  /// Sections that have entries, in the order the text report prints them.
  public var sections: [Section]

  /// Bytes the entries `--delete` acts on take, where the report measured them.
  public var reclaimableBytes: Int64 {
    sections.flatMap(\.entries).filter { $0.kept == nil }.compactMap(\.bytes).reduce(0, +)
  }

  public var deletableCount: Int {
    sections.flatMap(\.entries).filter { $0.kept == nil }.count
  }

  /// The payload's section keys in text order, with their headings.
  static let order: [(key: String, title: String)] = [
    ("deadProjects", "Dead project entries"),
    ("invalidProjects", "Invalid project entries"),
    ("orphanedPorts", "Orphaned ports"),
    ("orphanedWorkspaces", "Orphaned workspace directories"),
    ("linkedWorktrees", "Linked worktrees"),
    ("parkedSimulators", "Parked simulators"),
    ("parkedEmulators", "Parked emulators"),
    ("orphanedDevices", "Orphaned devices"),
    ("staleDevices", "Stale devices"),
    ("staleDeviceRecords", "Stale device records"),
    ("orphanedEasSessions", "Orphaned EAS sessions"),
    ("staleBuildLocks", "Stale build locks"),
    ("staleBuildSlots", "Stale build slots"),
    ("unresolvedBuildClaims", "Unresolved build claims"),
    ("buildsInProgress", "Builds in progress"),
    ("expiredDeviceLeases", "Expired device leases"),
    ("keptDeviceLeases", "Kept device leases"),
    ("deviceSweepNotices", "Device sweep notices"),
    ("easSessionSweepNotices", "EAS session sweep notices"),
    ("skipped", "Skipped"),
    ("workspaceBuildOutputs", "Workspace build outputs"),
    ("caches", "Shared caches"),
  ]

  /// Sections `stim guide facts gc` documents as never deleted.
  static let reportOnly: Set<String> = [
    "unresolvedBuildClaims", "buildsInProgress", "keptDeviceLeases", "deviceSweepNotices",
    "easSessionSweepNotices", "skipped",
  ]

  public init(json: Data) throws {
    guard let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else {
      throw Failure.unreadable
    }
    if let code = object["code"] as? String {
      throw Failure.refused(message: object["message"] as? String ?? code, remedy: object["remedy"] as? String)
    }
    guard let sections = object["sections"] as? [String: Any] else { throw Failure.unreadable }
    actionable = object["actionable"] as? Bool ?? false
    let known = Set(Self.order.map(\.key))
    let keys = Self.order + sections.keys.filter { !known.contains($0) }.sorted().map { ($0, $0) }
    self.sections = keys.compactMap { key, title in
      guard let items = sections[key] as? [[String: Any]], !items.isEmpty else { return nil }
      let entries = items.map { Self.entry($0, reportOnly: Self.reportOnly.contains(key)) }
      return Section(key: key, title: title, entries: entries)
    }
  }

  private static func entry(_ item: [String: Any], reportOnly: Bool) -> Entry {
    let label = ["name", "dir", "path", "project", "id", "message"].lazy.compactMap { item[$0] as? String }.first ?? "?"
    let bytes = (item["bytes"] as? NSNumber)?.int64Value
    let acted = ["willRemove", "willClear", "willEmpty"].compactMap { item[$0] as? Bool }.first
    let kept: String?
    if reportOnly {
      kept = item["detail"] as? String ?? "reported only"
    } else if acted == false {
      kept = item["detail"] as? String ?? item["emptySkipped"] as? String ?? item["note"] as? String ?? "kept"
    } else {
      kept = nil
    }
    return Entry(label: label, bytes: bytes, kept: kept)
  }
}
