import Foundation

public struct ArchivedPage: Sendable {
  public struct Retention: Sendable, Identifiable {
    public var title: String
    public var bytes: Int64
    public var until: Date?
    public var expired: Bool
    public var expiresSoon: Bool
    public var id: String { title }
  }

  public var record: ArchivedWorkspace
  public var retention: [Retention]
  public var cacheHits: Int?
  public var offloadedBuilds: Int?
  public var expiryLabel: String?
  public var pullRequestLabel: String?
  public var rowStatus: RowStatus { RowStatus(kind: .idle, text: "Removed", label: "Removed", tone: .tertiary) }
  public var workspace: Workspace
  public var removedAt: Date?
  public var statusLine: String
  public var lastUsedLabel: String?
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
      ("Logs", archive.bytes.logs, archive.expires.logs),
      ("Recordings", archive.bytes.recordings, archive.expires.recordings),
      ("Agent actions", archive.bytes.agentActions, archive.expires.agentActions),
      ("Record", archive.bytes.record, archive.expires.record),
    ].map { title, bytes, stamp in
      let until = stamp.flatMap(parseTimestamp)
      let expired = bytes == 0 || until.map { $0 < now } == true
      return Retention(
        title: title, bytes: bytes, until: until, expired: expired,
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
    let ios = detail == nil ? (last?.platform == "ios" ? last : nil) : builds?.ios?.first?.build
    let android = detail == nil ? (last?.platform == "android" ? last : nil) : builds?.android?.first?.build
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
    sizeLabel = archive.sizeLabel
    logsExpired = retention[0].expired
    recordingsExpired = retention[1].expired
    recordings = detail?.recordings ?? []
    replacedBy = archive.replacedBy
  }
}
