import Foundation

/// What a `stim gc --delete --json` or `stim gc --idle --json` run did, reduced to a short summary: the
/// entries it acted on, the ones it left alone and why, and the ones that failed.
public struct GcOutcome: Hashable, Sendable {
  public enum Status: String, Hashable, Sendable {
    case done
    case kept
    case failed
  }

  public struct Item: Hashable, Sendable {
    public var kind: String
    public var status: Status
    public var label: String
    public var id: String?
    public var bytes: Int64?
    public var detail: String?
  }

  public var done: [Item]
  public var kept: [Item]
  public var failed: [Item]
  /// Entries the CLI counted as failed. It can exceed `failed.count` on a CLI that predates `results`.
  public var failures: Int

  public var freedBytes: Int64 { done.compactMap(\.bytes).filter { $0 > 0 }.reduce(0, +) }

  /// One line such as "Freed 20.2 GB · Deleted 3 devices".
  public var headline: String {
    var parts: [String] = []
    if freedBytes > 0 { parts.append("Freed \(ByteCountFormatter.string(fromByteCount: freedBytes, countStyle: .file))") }
    for (phrase, count) in Self.phrases(done) { parts.append(phrase(count)) }
    if parts.isEmpty { return failures > 0 ? "Nothing was cleaned up" : "Nothing to clean up" }
    return parts.joined(separator: " \u{00B7} ")
  }

  /// Whether `arguments` run a `stim gc` that acts and prints its outcome as JSON.
  public static func describes(_ arguments: [String]) -> Bool {
    arguments.first == "gc" && arguments.contains("--json")
      && (arguments.contains("--delete") || arguments.contains("--idle"))
  }

  public init(json: Data) throws {
    guard let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else {
      throw GcPreview.Failure.unreadable
    }
    if let code = object["code"] as? String {
      throw GcPreview.Failure.refused(message: object["message"] as? String ?? code, remedy: object["remedy"] as? String)
    }
    let sections = object["sections"] as? [String: Any] ?? [:]
    var items: [Item]
    if let results = object["results"] as? [[String: Any]] {
      items = results.compactMap { result in
        guard let status = (result["status"] as? String).flatMap(Status.init(rawValue:)),
          let label = result["label"] as? String
        else { return nil }
        return Item(
          kind: result["kind"] as? String ?? "entry", status: status, label: label, id: result["id"] as? String,
          bytes: (result["bytes"] as? NSNumber)?.int64Value, detail: result["detail"] as? String)
      }
    } else {
      items = ((try? GcPreview(json: json))?.sections ?? []).flatMap { section in
        section.entries.filter { $0.kept == nil }.map {
          Item(kind: section.key, status: .done, label: $0.label, id: nil, bytes: $0.bytes, detail: nil)
        }
      }
    }
    if object["mode"] as? String == "delete" { items += Self.notes(sections) }
    var seen = Set<String>()
    items = items.filter { seen.insert("\($0.status)|\($0.kind)|\($0.id ?? $0.label)|\($0.label)").inserted }
    done = items.filter { $0.status == .done }
    kept = items.filter { $0.status == .kept }
    failed = items.filter { $0.status == .failed }
    failures = max((object["failures"] as? NSNumber)?.intValue ?? 0, failed.count)
  }

  /// Report lines a delete run leaves alone by design: unrecognized devices, entries gc skipped, and sweep notices.
  private static func notes(_ sections: [String: Any]) -> [Item] {
    func rows(_ key: String) -> [[String: Any]] { sections[key] as? [[String: Any]] ?? [] }
    var notes: [Item] = []
    for row in rows("unverifiedDevices") {
      guard let name = row["name"] as? String else { continue }
      let command = row["command"] as? String
      notes.append(
        Item(
          kind: "unverifiedDevice", status: .kept, label: name, id: row["id"] as? String, bytes: nil,
          detail: "Not created by this Stim home" + (command.map { "; to delete it, run \($0)" } ?? "")))
    }
    for row in rows("skipped") {
      guard let path = row["path"] as? String else { continue }
      notes.append(Item(kind: "skipped", status: .kept, label: path, id: nil, bytes: nil, detail: row["detail"] as? String))
    }
    for key in ["deviceSweepNotices", "easSessionSweepNotices"] {
      for row in rows(key) {
        guard let message = row["message"] as? String else { continue }
        notes.append(Item(kind: key, status: .kept, label: message, id: nil, bytes: nil, detail: nil))
      }
    }
    return notes
  }

  private static func phrases(_ items: [Item]) -> [((Int) -> String, Int)] {
    let groups: [(kinds: Set<String>, phrase: (Int) -> String)] = [
      (["device", "parkedDevice", "orphanedDevices", "staleDevices", "parkedSimulators", "parkedEmulators"],
       { "Deleted \(count($0, "device"))" }),
      (["idleDevice"], { "Shut down \(count($0, "idle device"))" }),
      (["worktree", "linkedWorktrees"], { "Removed \(count($0, "worktree"))" }),
      (["workspaceOutputs", "workspaceBuildOutputs"], { "Cleared build outputs of \(count($0, "workspace"))" }),
      (["workspaceDirectory", "orphanedWorkspaces"], { "Removed \(count($0, "workspace directory", "workspace directories"))" }),
      (["cache", "caches"], { "Cleaned \(count($0, "cache"))" }),
      (["easSession", "orphanedEasSessions"], { "Stopped \(count($0, "EAS session"))" }),
      (["project", "deadProjects", "invalidProjects"], { "Pruned \(count($0, "project entry", "project entries"))" }),
    ]
    let known = groups.reduce(Set<String>()) { $0.union($1.kinds) }
    var result: [((Int) -> String, Int)] = groups.compactMap { group in
      let n = items.filter { group.kinds.contains($0.kind) }.count
      return n > 0 ? (group.phrase, n) : nil
    }
    let other = items.filter { !known.contains($0.kind) }.count
    if other > 0 { result.append(({ "Cleared \(count($0, "stale record"))" }, other)) }
    return result
  }

  private static func count(_ n: Int, _ singular: String, _ plural: String? = nil) -> String {
    "\(n) \(n == 1 ? singular : plural ?? singular + "s")"
  }
}
