import Foundation

public struct ArchivedPage: Sendable {
  public struct Retention: Sendable, Identifiable {
    public var title: String
    public var kind: RetainedKind?
    public var bytes: Int64
    public var until: Date?
    public var expired: Bool
    public var expiresSoon: Bool
    public var id: String { title }
    public var clearable: Bool { kind != nil && bytes > 0 }
  }

  public var record: ArchivedWorkspace
  public var retention: [Retention]
  public var cacheHits: Int?
  public var offloadedBuilds: Int?
  public var expiryLabel: String?
  public var pullRequestLabel: String?
  public var buildTotalsLine: String {
    var parts = [countLabel(record.builds.count, "build")]
    if let cacheHits { parts.append(countLabel(cacheHits, "cache hit")) }
    if let offloadedBuilds { parts.append("\(offloadedBuilds) on a remote Mac") }
    parts.append("\(countLabel(record.builds.lastErrorCount, "error")) at removal")
    return parts.joined(separator: " \u{00B7} ")
  }
  public var rowStatus: RowStatus { RowStatus(kind: .idle, text: "Removed", label: "Removed", tone: .tertiary) }
  public var workspace: Workspace
  public var removedAt: Date?
  public var statusLine: String
  public var lastUsedLabel: String?
  public var removedLabel: String
  public var sizeLabel: String
  public var merged: Bool
  public var logsExpired: Bool
  public var recordingsExpired: Bool
  public var recordings: [ArchiveDetail.Recording]
  public var replacedBy: String?

  public init(archive: ArchivedWorkspace, detail: ArchiveDetail? = nil, now: Date) {
    record = archive
    removedAt = parseTimestamp(archive.removedAt)
    retention = [
      ("Logs", RetainedKind.logs, archive.bytes.logs, archive.expires.logs),
      ("Recordings", RetainedKind.recordings, archive.bytes.recordings, archive.expires.recordings),
      ("Agent actions", RetainedKind.agentActions, archive.bytes.agentActions, archive.expires.agentActions),
      ("Record", nil, archive.bytes.record, archive.expires.record),
    ].map { title, kind, bytes, stamp in
      let until = stamp.flatMap(parseTimestamp)
      let expired = until.map { $0 < now } == true
      return Retention(
        title: title, kind: kind, bytes: bytes, until: until, expired: expired,
        expiresSoon: !expired && until.map { $0 <= now.addingTimeInterval(86400) } == true)
    }
    let media = retention.prefix(2)
    expiryLabel = media.contains(where: \.expired) ? "Media expired" : media.contains(where: \.expiresSoon) ? "Expires soon" : nil
    let isMerged = archive.worktree.merged == true || archive.worktree.pullRequest?.state == "merged"
    merged = isMerged
    pullRequestLabel =
      archive.worktree.pullRequest.map { "#\($0.number)" + (isMerged ? " \u{00B7} Merged" : "") }
      ?? (isMerged ? "Merged" : nil)
    var pull = archive.worktree.pullRequest
    pull?.state = isMerged ? "merged" : ""
    pull?.checks = nil
    pull?.reviewDecision = nil
    let builds = detail?.builds
    let entries = (builds?.ios ?? []) + (builds?.android ?? [])
    cacheHits = detail.map { _ in entries.filter { $0.build.cacheHit != .none }.count }
    offloadedBuilds = detail.map { _ in entries.filter { $0.build.offloadedTo != nil }.count }
    let last = archive.builds.last
    let ios = builds?.ios?.first?.build ?? (last?.platform == "ios" ? last : nil)
    let android = builds?.android?.first?.build ?? (last?.platform == "android" ? last : nil)
    workspace = Workspace(
      path: archive.projectRoot,
      platforms: ["ios", "android"].filter { $0 == "ios" ? ios != nil : android != nil },
      live: false, warnings: [], lastBuilds: LastBuilds(ios: ios, android: android), builds: builds,
      worktree: WorktreeInfo(
        path: archive.worktreeRoot, branch: archive.worktree.branch, merged: archive.worktree.merged,
        repository: archive.worktree.repository,
        pullRequest: pull),
      endedAgents: archive.agents, titleOverride: archive.title)
    statusLine = "\(archive.removedLabel(now: now)) by \(archive.removedByLabel)"
    lastUsedLabel = archive.lastUsedLabel(now: now)
    removedLabel = archive.removedLabel(now: now)
    sizeLabel = archive.sizeLabel
    logsExpired = retention[0].expired
    recordingsExpired = retention[1].expired
    recordings = detail?.recordings.filter { !$0.spans.isEmpty } ?? []
    replacedBy = archive.replacedBy
  }
}
