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
    ("unverifiedDevices", "Unrecognized stim-* devices"),
    ("simulatorLaunchdFolders", "Simulator launchd folders with no simulator"),
    ("staleDevices", "Stale devices"),
    ("staleDeviceRecords", "Stale device records"),
    ("staleLedgerEntries", "Stale device ledger entries"),
    ("staleStatusCaches", "Stale status cache entries"),
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
    ("workspaceLogs", "Workspace logs"),
    ("workspaceBuildOutputs", "Workspace build outputs"),
    ("recordings", "Device recordings"),
    ("caches", "Shared caches"),
  ]

  /// Sections `stim guide facts gc` documents as never deleted.
  static let reportOnly: Set<String> = [
    "unresolvedBuildClaims", "buildsInProgress", "keptDeviceLeases", "deviceSweepNotices",
    "easSessionSweepNotices", "skipped", "unverifiedDevices", "simulatorLaunchdFolders",
  ]

  /// The `stim gc` arguments that act on what a dry run with `preview` reported: the same scope with
  /// `--delete`, so a preview of one cache never becomes a full `gc --delete`. Nil for arguments that are
  /// not a `gc --json` dry run.
  public static func deleteArguments(after preview: [String]) -> [String]? {
    guard preview.first == "gc", preview.contains("--json"), !preview.contains("--delete") else { return nil }
    return preview + ["--delete"]
  }

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
    self.sections =
      keys.compactMap { key, title in
        let items = ((sections[key] as? [[String: Any]]) ?? []).filter {
          key != "workspaceLogs" || (($0["trimBytes"] as? NSNumber)?.int64Value ?? 0) > 0
        }
        guard !items.isEmpty else { return nil }
        let entries = items.map { Self.entry($0, key: key) }
        return Section(key: key, title: title, entries: entries)
      } + Self.ladderSection(object["ladder"])
  }

  /// What `stim gc --delete` runs of the pressure ladder: its high level, as the dry run previewed it.
  private static func ladderSection(_ ladder: Any?) -> [Section] {
    let levels = (ladder as? [String: Any])?["levels"] as? [[String: Any]] ?? []
    let actions = levels.first { $0["level"] as? String == "high" }?["actions"] as? [[String: Any]] ?? []
    guard !actions.isEmpty else { return [] }
    let entries = actions.map { action in
      Entry(
        label:
          "\((action["kind"] as? String ?? "?").replacingOccurrences(of: "-", with: " ")) \(action["target"] as? String ?? "?")",
        bytes: (action["bytes"] as? NSNumber)?.int64Value,
        kept: action["outcome"] as? String == "kept" ? action["detail"] as? String ?? "kept" : nil)
    }
    return [Section(key: "ladder", title: "Pressure ladder at high", entries: entries)]
  }

  private static func entry(_ item: [String: Any], key: String) -> Entry {
    let reportOnly = Self.reportOnly.contains(key)
    let labelKeys = key == "recordings" ? ["projectRoot", "dir"] : ["name", "dir", "path", "project", "id", "message"]
    let label = labelKeys.lazy.compactMap { item[$0] as? String }.first ?? "?"
    let acted = ["willRemove", "willClear", "willEmpty", "willTrim", "willDelete"].compactMap { item[$0] as? Bool }.first
    let bytesKey = key == "workspaceLogs" ? "trimBytes" : key == "recordings" && acted == true ? "deleteBytes" : "bytes"
    let bytes = (item[bytesKey] as? NSNumber)?.int64Value
    let kept: String?
    if key == "unverifiedDevices" {
      kept = "This Stim home has no record of creating it; to delete it, run: \(item["command"] as? String ?? "?")"
    } else if key == "simulatorLaunchdFolders" {
      kept =
        "No simulator in Xcode's device set has this UDID; once its simulator is gone for good, run: \(item["command"] as? String ?? "?")"
    } else if key == "recordings", item["withWorkspace"] as? Bool == true {
      kept = "deleted with its workspace directory, counted there"
    } else if reportOnly {
      kept = item["detail"] as? String ?? "reported only"
    } else if acted == false {
      kept = item["detail"] as? String ?? item["emptySkipped"] as? String ?? item["note"] as? String ?? "kept"
    } else {
      kept = nil
    }
    return Entry(label: label, bytes: bytes, kept: kept)
  }
}
