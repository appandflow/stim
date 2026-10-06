import Foundation

public struct ArchivedWorkspace: Decodable, Hashable, Identifiable, Sendable {
  public struct Worktree: Decodable, Hashable, Sendable {
    public var repository: String?
    public var branch: String?
    public var head: String?
    public var subject: String?
    public var merged: Bool?
    public var pullRequest: PullRequestFacts?
  }

  public struct Builds: Decodable, Hashable, Sendable {
    public var count: Int
    public var last: LastBuild?
    public var lastErrorCount: Int

    enum CodingKeys: String, CodingKey { case count, last, lastErrorCount }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      count = (try? c.decode(Int.self, forKey: .count)) ?? 0
      last = try c.decodeIfPresent(LastBuild.self, forKey: .last)
      lastErrorCount = (try? c.decode(Int.self, forKey: .lastErrorCount)) ?? 0
    }
  }

  public struct Bytes: Decodable, Hashable, Sendable {
    public var logs: Int64
    public var recordings: Int64
    public var agentActions: Int64
    public var record: Int64
    public var total: Int64
  }

  public struct Expires: Decodable, Hashable, Sendable {
    public var logs: String?
    public var recordings: String?
    public var agentActions: String?
    public var record: String?
  }

  public var id: String
  public var projectRoot: String
  public var project: String
  public var workspace: String
  public var worktree: Worktree
  public var removedAt: String
  public var removedBy: String
  public var lastUsedAt: String?
  public var builds: Builds
  public var agents: [AgentSession]
  public var bytes: Bytes
  public var expires: Expires
  public var version: Int
  public var replacedBy: String?

  public var title: String { worktree.branch ?? project }
  public var sidebarProject: Project {
    worktree.repository.map { Project(root: $0) } ?? Project(fallbackFor: projectRoot)
  }
  public var sizeLabel: String { Format.fileSize(bytes.total) }
  public var removedByLabel: String {
    switch removedBy {
    case "worktree-remove": return "worktree removal"
    case "gc": return "garbage collection"
    default: return removedBy.replacingOccurrences(of: "-", with: " ")
    }
  }

  public func removedLabel(now: Date) -> String {
    guard let date = parseTimestamp(removedAt) else { return "Removed \(removedAt)" }
    let elapsed = now.timeIntervalSince(date)
    let age = elapsed >= 86400 ? "\(Format.duration(elapsed)) ago" : Format.age(elapsed)
    return "Removed \(age)"
  }

  public func lastUsedLabel(now: Date) -> String? {
    lastUsedAt.flatMap(parseTimestamp).map { "Last used \(Format.age(now.timeIntervalSince($0)))" }
  }

  public func isEarlierRun(of path: String) -> Bool {
    projectRoot == path || replacedBy == path
  }

  public static func newestFirst(_ archives: [Self]) -> [Self] {
    archives.sorted {
      let a = parseTimestamp($0.removedAt) ?? .distantPast
      let b = parseTimestamp($1.removedAt) ?? .distantPast
      return a == b ? $0.id > $1.id : a > b
    }
  }

  public func deleteCommand(cwd: String) -> StimCommand {
    StimCommand(["gc", "--delete", "--cache", "archived:\(id)"], cwd: cwd)
  }
}

public struct ArchivedUsage: Decodable, Equatable, Sendable {
  public struct ByKind: Decodable, Equatable, Sendable {
    public var logs: Int64
    public var recordings: Int64
    public var agentActions: Int64
    public var record: Int64
  }

  public struct Row: Equatable, Sendable {
    public var title: String
    public var bytes: Int64
    public var settings: String
  }

  public var count: Int
  public var bytes: Int64
  public var byKind: ByKind

  public var storageRows: [Row] {
    guard count > 0 else { return [] }
    return [
      Row(title: "Logs", bytes: byKind.logs, settings: "archive.logs.maxMbPerWorkspace"),
      Row(title: "Recordings", bytes: byKind.recordings, settings: "archive.recordings.maxTotalGb"),
      Row(title: "Agent actions", bytes: byKind.agentActions, settings: "archive.agentActions.maxAgeDays"),
      Row(title: "Records", bytes: byKind.record, settings: "archive.maxCount / archive.maxAgeDays"),
    ]
  }
}

public func archivedReadError(_ error: Error, content: String) -> String {
  if let error = error as? ServerError, error.code == "bad-request",
    error.message.contains("params.workspace"), !error.message.contains("params.archive")
  {
    return "Update stim-server to view archived \(content)"
  }
  return error.localizedDescription
}

@MainActor func retryArchiveRead<T>(_ read: @MainActor () async throws -> T) async throws -> T {
  for _ in 0..<3 {
    try Task.checkCancellation()
    do {
      return try await read()
    } catch let error as ServerError where error.code == "limit-exceeded" {
      try await Task.sleep(for: .milliseconds(250))
    }
  }
  try Task.checkCancellation()
  return try await read()
}
