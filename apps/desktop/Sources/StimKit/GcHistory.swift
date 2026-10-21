import Foundation

/// One item of `stim logs --source gc --json`: something a `gc` run, a maintenance action or the budget gate
/// cleared, kept or failed to clear. Fields newer than this app are ignored.
public struct GcHistoryItem: Decodable, Hashable, Sendable {
  public enum Status: String, Decodable, Sendable {
    case done, kept, failed
  }

  /// Epoch milliseconds.
  public var ts: Double
  public var runId: String
  /// `manual`, `desktop`, `maintenance` or `budget`; a trigger newer than this app decodes as written.
  public var trigger: String
  /// For maintenance, the command whose run started the pass.
  public var via: String?
  public var options: Options?
  public var kind: String
  public var status: Status
  public var label: String
  public var path: String?
  public var bytes: Double?
  public var detail: String?

  public struct Options: Decodable, Hashable, Sendable {
    public var delete: Bool?
    public var worktrees: Bool?
    public var olderThan: Int?
    public var cache: String?
    public var idleMs: Int?
  }

  public var date: Date { Date(timeIntervalSince1970: ts / 1000) }

  /// What the item was, in words; a kind newer than this app shows as written.
  public var kindTitle: String {
    Self.kindTitles[kind] ?? kind
  }

  private static let kindTitles: [String: String] = [
    "archive": "Archive", "device": "Device", "parkedDevice": "Parked device",
    "parkedHostedDevice": "Parked hosted device", "idleDevice": "Idle device", "deviceRecord": "Device record",
    "workspaceOutputs": "Build outputs", "recording": "Recording", "workspaceDirectory": "Workspace folder",
    "project": "Project entry", "buildLock": "Build lock", "buildSlot": "Build slot", "deviceLease": "Device lease",
    "easSession": "EAS session", "worktree": "Worktree", "cache": "Cache", "statusCache": "Status cache",
    "tempLeftover": "Temp leftover", "trash": "Trash", "watchmanRoot": "Watchman root", "watchman": "Watchman",
    "gradleDaemon": "Gradle daemon", "gradleVersion": "Gradle version", "kotlinDaemon": "Kotlin daemon",
    "devServer": "Dev server", "buildDirectory": "Build folder", "dependencies": "Dependencies",
  ]
}

/// The items one run wrote, newest run first in `GcHistory.runs`.
public struct GcRun: Identifiable, Hashable, Sendable {
  public var id: String
  public var trigger: String
  public var via: String?
  public var options: GcHistoryItem.Options?
  public var items: [GcHistoryItem]

  public var date: Date { items.last?.date ?? .distantPast }
  public var cleared: [GcHistoryItem] { items.filter { $0.status == .done } }
  public var kept: [GcHistoryItem] { items.filter { $0.status == .kept } }
  public var failed: [GcHistoryItem] { items.filter { $0.status == .failed } }
  public var freedBytes: Int64 { cleared.reduce(0) { $0 + Int64($1.bytes ?? 0) } }

  public var title: String {
    switch trigger {
    case "maintenance": return "Automatic maintenance"
    case "budget": return "Disk and memory budget"
    case "desktop": return "Cleanup from Stim Desktop"
    case "manual": return "Cleanup from stim gc"
    default: return "Cleanup"
    }
  }

  /// Why the run happened, such as the command that started a maintenance pass or the `stim gc` options.
  public var reason: String? {
    switch trigger {
    case "maintenance": return via.map { "Started by stim \($0)" }
    case "budget": return "Before a build, to stay inside the budget"
    default: return options?.command
    }
  }

  /// "Cleared 3, kept 1, failed 1, freed 1.2 GB".
  public var summary: String {
    var parts: [String] = []
    if !cleared.isEmpty { parts.append("Cleared \(cleared.count)") }
    if !kept.isEmpty { parts.append("kept \(kept.count)") }
    if !failed.isEmpty { parts.append("failed \(failed.count)") }
    var line = parts.joined(separator: ", ")
    if freedBytes > 0 { line += (line.isEmpty ? "" : ", ") + "freed \(Format.fileSize(freedBytes))" }
    return line.prefix(1).uppercased() + line.dropFirst()
  }
}

extension GcHistoryItem.Options {
  /// The `stim gc` line these options came from.
  public var command: String {
    var words = ["stim", "gc"]
    if delete == true { words.append("--delete") }
    if worktrees == true { words.append("--worktrees") }
    if let olderThan { words += ["--older-than", String(olderThan)] }
    if let cache { words += ["--cache", cache] }
    if let idleMs { words += ["--idle", "\(idleMs / 60_000)m"] }
    return words.joined(separator: " ")
  }
}

public enum GcHistory {
  /// The records of NDJSON `output`, skipping lines that are not gc log records.
  public static func parse(_ output: Data) -> [GcHistoryItem] {
    String(decoding: output, as: UTF8.self).split(separator: "\n").compactMap { line in
      try? JSONDecoder().decode(GcHistoryItem.self, from: Data(line.utf8))
    }
  }

  /// `items` grouped by run, the run that wrote last first. A run keeps its items in the order they were written.
  public static func runs(_ items: [GcHistoryItem]) -> [GcRun] {
    var order: [String] = []
    var byId: [String: GcRun] = [:]
    for item in items {
      if var run = byId[item.runId] {
        run.items.append(item)
        byId[item.runId] = run
      } else {
        order.append(item.runId)
        byId[item.runId] = GcRun(
          id: item.runId, trigger: item.trigger, via: item.via, options: item.options, items: [item])
      }
    }
    return order.compactMap { byId[$0] }.sorted { $0.date > $1.date }
  }
}

extension StimCLI {
  /// The newest `limit` records of the machine gc log. The log is machine-wide, so any directory works.
  public func gcHistory(limit: Int = 2000) async throws -> [GcHistoryItem] {
    GcHistory.parse(try await run(["logs", "--source", "gc", "--json", "--tail", String(limit)], cwd: NSHomeDirectory()))
  }
}
