import Foundation
import Testing

@testable import StimKit

@Suite struct ArchivedWorkspaceTests {
  private func payload() throws -> StatusPayload {
    try JSONDecoder().decode(
      StatusPayload.self,
      from: Data(contentsOf: Bundle.module.url(forResource: "Fixtures/archived-status.json", withExtension: nil)!))
  }

  @Test func archivedHistoryRetainsBuildReasonsPullRequestAndEndedAgents() throws {
    let payload = try payload()
    let archive = try #require(payload.archived?.first)
    #expect(archive.worktree.pullRequest?.state == "merged")
    #expect(archive.worktree.head == "abc123")
    #expect(archive.worktree.merged == true)
    #expect(archive.builds.count == 4)
    #expect(archive.builds.last?.summary == "Cache miss, compiled in 0m 42s")
    #expect(archive.builds.last?.missReason?.changes.first?.source == "ios/App.swift")
    #expect(archive.agents.first?.endedAt == "2026-10-04T11:00:00Z")
    #expect(archive.expires.logs == "2026-11-04T12:00:00Z")
    #expect(payload.archivedUsage?.bytes == archive.bytes.total)
  }

  @Test func absentOptionalHistoryAndNewRemovalKindsDoNotBreakStatusDecoding() throws {
    let data = try Data(contentsOf: Bundle.module.url(forResource: "Fixtures/archived-status.json", withExtension: nil)!)
    var object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    var records = try #require(object["archived"] as? [[String: Any]])
    records[0].removeValue(forKey: "replacedBy")
    records[0].removeValue(forKey: "lastUsedAt")
    records[0]["worktree"] = [:] as [String: Any]
    records[0]["expires"] = [:] as [String: Any]
    records[0]["builds"] = [:] as [String: Any]
    records[0]["removedBy"] = "future-cleanup"
    object["archived"] = records
    let decoded = try JSONDecoder().decode(StatusPayload.self, from: JSONSerialization.data(withJSONObject: object))
    let archive = try #require(decoded.archived?.first)
    #expect(archive.removedBy == "future-cleanup")
    #expect(archive.removedByLabel == "future cleanup")
    #expect(archive.title == "Example")
    #expect(archive.builds.count == 0)
    #expect(archive.builds.lastErrorCount == 0)
    #expect(archive.builds.last == nil)
    #expect(archive.lastUsedAt == nil)
    #expect(archive.replacedBy == nil)
    #expect(archive.worktree.pullRequest == nil)
    #expect(archive.expires.record == nil)
    let old = try JSONDecoder().decode(StatusPayload.self, from: Data(#"{"environments":[]}"#.utf8))
    #expect(old.archived == nil)
    #expect(old.archivedUsage == nil)
  }

  @Test func liveFiltersExcludeArchivesAndArchivedGroupsOnlyHistoryNewestFirst() throws {
    let payload = try payload()
    var older = try #require(payload.archived?.first)
    var newer = older
    newer.id = "newer"
    newer.removedAt = "2026-10-05T12:00:00Z"
    var other = older
    other.id = "other-project"
    other.worktree.repository = "/work/another"
    older.id = "older"
    let archives = [older, other, newer]
    let project: (String) -> Project = { _ in Project(root: "/work/live") }
    var options = SidebarOptions()
    for filter in [StatusFilter.all, .live, .idle] {
      options.status = filter
      let rows = sidebarList(
        environments: payload.environments, unprovisioned: [], project: project, options: options, archived: archives)
      #expect(
        rows.map(\.id)
          == (filter == .all ? ["/work/idle/app", "/work/new/app"] : filter == .live ? ["/work/new/app"] : ["/work/idle/app"]))
    }
    options.status = .archived
    let trees = sidebarTrees(
      environments: payload.environments, unprovisioned: [], project: project, options: options, archived: archives)
    #expect(trees.map { $0.summary.project.root } == ["/work/another", "/work/example"])
    #expect(trees[1].entries.map(\.id) == ["archive:newer", "archive:older"])
    #expect(trees[1].summary.total == 2)
    let rows = sidebarList(
      environments: payload.environments, unprovisioned: [], project: project, options: options, archived: archives)
    #expect(rows.first?.id == "archive:newer")
    options.hiddenProjects = ["/work/example"]
    #expect(sidebarTrees(environments: [], unprovisioned: [], project: project, options: options, archived: archives).count == 1)
  }

  @Test func rowNamesRemovalAgeAndEarlierRunsDistinguishReusedPaths() throws {
    let archive = try #require(payload().archived?.first)
    #expect(archive.title == "feature-search")
    #expect(archive.removedLabel(now: try #require(parseTimestamp("2026-10-06T12:00:00Z"))) == "Removed 2d ago")
    #expect(archive.sizeLabel == Format.fileSize(3147776))
    #expect(archive.removedByLabel == "worktree removal")
    #expect(archive.isEarlierRun(of: "/work/feature/app"))
    #expect(archive.isEarlierRun(of: "/work/new/app"))
    #expect(!archive.isEarlierRun(of: "/work/feature/app-other"))
    #expect(!archive.isEarlierRun(of: "/work/example"))
  }

  @Test func aRemovedWorkspacePathFindsItsNewestArchive() throws {
    let archive = try #require(payload().archived?.first)
    var older = archive
    older.id = "older"
    older.removedAt = "2026-10-01T12:00:00Z"
    var newer = archive
    newer.id = "newer"
    newer.removedAt = "2026-10-05T12:00:00Z"
    #expect(ArchivedWorkspace.newest(removedFrom: archive.projectRoot, in: [older, newer])?.id == "newer")
    #expect(ArchivedWorkspace.newest(removedFrom: archive.projectRoot + "-other", in: [older, newer]) == nil)
  }

  @Test func archiveStorageKeepsEachRetentionSettingAndHidesAnEmptyCollection() throws {
    var usage = try #require(payload().archivedUsage)
    #expect(usage.count == 1)
    #expect(usage.storageRows.map(\.title) == ["Logs", "Recordings", "Agent actions", "Records"])
    #expect(usage.storageRows.map(\.bytes) == [1048576, 2097152, 1024, 1024])
    #expect(
      usage.storageRows.map(\.settings) == [
        "archive.logs.maxMbPerWorkspace", "archive.recordings.maxTotalGb", "archive.agentActions.maxAgeDays",
        "archive.maxCount / archive.maxAgeDays",
      ])
    usage.count = 0
    #expect(usage.storageRows.isEmpty)
  }

  @Test func archiveDeletionTargetsOnlyTheSelectedArchive() throws {
    let archive = try #require(payload().archived?.first)
    let command = archive.deleteCommand(cwd: "/home")
    #expect(command.arguments == ["gc", "--delete", "--cache", "archived:archive-older"])
    #expect(command.cwd == "/home")
  }

  @Test func archiveLogsPreserveFiltersWithoutWorkspaceOrFollow() throws {
    var query = LogQuery()
    query.sources = [.build, .agent]
    query.slot = "fold"
    query.minimumLevel = .warn
    query.search = "error.*"
    query.errorsOnly = true
    let request = ArchivedLogsRequest(archive: "ended", query: query)
    #expect(
      request.params == [
        "archive": .string("ended"), "tail": .number(5000), "sources": .array([.string("build"), .string("agent")]),
        "slot": .string("fold"), "level": .string("warn"), "grep": .string("error.*"), "errors": .bool(true),
      ])
  }

  @Test(arguments: [
    "params.workspace is required.",
    "replay.range needs params.workspace and params.platform (ios, android or web).",
    "frames.subscribe needs params.workspace and params.platform (ios, android or web).",
    "replay.keyframe needs params.workspace and params.platform (ios, android or web).",
  ])
  func oldServerArchiveRefusalsExplainHowToReadHistory(_ message: String) {
    let refusal = ServerError(code: "bad-request", message: message)
    #expect(archivedReadError(refusal, content: "logs") == "Update stim-server to view archived logs")
    #expect(archivedReadError(refusal, content: "replay") == "Update stim-server to view archived replay")
  }

  @Test(arguments: [
    ServerError(code: "bad-request", message: "grep must be a valid regular expression without NUL characters."),
    ServerError(code: "bad-request", message: "params.workspace or params.archive is required."),
    ServerError(code: "forbidden", message: "Read access required"),
  ])
  func currentServerRefusalsKeepTheirOwnMessage(_ refusal: ServerError) {
    #expect(archivedReadError(refusal, content: "logs") == refusal.message)
    #expect(archivedReadError(refusal, content: "replay") == refusal.message)
  }

  @Test func malformedArchivesDoNotHideLiveWorkspacesOrOtherHistory() throws {
    let data = try Data(contentsOf: Bundle.module.url(forResource: "Fixtures/archived-status.json", withExtension: nil)!)
    var object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let records = try #require(object["archived"] as? [[String: Any]])
    var valid = records[0]
    valid["builds"] = ["count": "unknown", "lastErrorCount": NSNull()]
    var malformed = records[0]
    malformed["id"] = 123
    object["archived"] = [malformed, valid, NSNull(), records[0]] as [Any]
    let decoded = try JSONDecoder().decode(StatusPayload.self, from: JSONSerialization.data(withJSONObject: object))
    #expect(decoded.environments.map(\.path) == (try payload()).environments.map(\.path))
    #expect(decoded.archived?.map(\.id) == ["archive-older", "archive-older"])
    #expect(decoded.archived?.first?.builds.count == 0)
    #expect(decoded.archived?.first?.builds.lastErrorCount == 0)
    #expect(decoded.archived?.last?.builds.count == 4)
  }

  @Test func archivesWithoutRepositoryFactsUseTheLiveProjectFallback() throws {
    var archive = try #require(payload().archived?.first)
    archive.worktree.repository = nil
    archive.projectRoot = "/work/example/.worktrees/feature/app"
    #expect(archive.sidebarProject == Project(fallbackFor: archive.projectRoot))
    var options = SidebarOptions()
    options.status = .archived
    let trees = sidebarTrees(
      environments: [], unprovisioned: [], project: { Project(fallbackFor: $0) }, options: options, archived: [archive])
    #expect(trees.first?.summary.project.root == "/work/example")
    options.hiddenProjects = ["/work/example"]
    #expect(
      sidebarList(
        environments: [], unprovisioned: [], project: { Project(fallbackFor: $0) }, options: options, archived: [archive]
      ).isEmpty)
  }

  @MainActor @Test func archiveReplayHoverRequestsKeyframesFromTheSameArchive() async throws {
    let server = FakeServer()
    let previews = ReplayPreviews(target: ReplayTarget(archive: "ended", platform: "android"))
    previews.connect(server)
    previews.want(1000, within: 0...2000)
    await settle()
    let request = try #require(server.take("replay.keyframe"))
    #expect(
      request.params == [
        "archive": .string("ended"), "platform": .string("android"), "slot": .string("default"), "at": .number(1000),
      ])
    request.reply.resume(returning: .null)
    await settle()
    previews.connect(nil)
  }

  @MainActor @Test(arguments: ["subscribe", "seek"])
  func archiveRangeIsReadOnceAndPreservesAFrameError(_ operation: String) async throws {
    let server = FakeServer()
    var scheduled: [TimeInterval] = []
    let controller = ReplayController(
      target: ReplayTarget(archive: "ended", platform: "ios"),
      scheduler: { delay, _ in
        scheduled.append(delay)
        return {}
      })
    let loaded = controller.connect(server)
    await settle()
    let request = try #require(server.take("replay.range"))
    controller.seek(at: 1000, rate: 0)
    let sub = try #require(server.subs.first)
    if operation == "subscribe" {
      sub.onEvent(
        ServerEvent(
          name: "error", subscription: "",
          fields: [
            "error": .object(["code": .string("no-recording"), "message": .string("Recording was removed.")])
          ]))
    } else {
      sub.onSubscribed(["subscription": .string("frames"), "video": .string("h264")])
      controller.seek(at: 1500, rate: 0)
      await settle()
      try #require(server.take("frames.seek")).reply.resume(
        throwing: ServerError(code: "no-recording", message: "Recording was removed."))
      await settle()
    }
    request.reply.resume(
      returning: .object([
        "enabled": .bool(true), "recording": .bool(false),
        "spans": .array([.object(["start": .number(1000), "end": .number(2000)])]), "markers": .array([]),
      ]))
    await loaded?.value
    #expect(controller.range?.spans == [ReplaySpan(start: 1000, end: 2000)])
    #expect(controller.error == "Recording was removed.")
    #expect(scheduled.isEmpty)
    controller.stop()
  }

  @MainActor @Test func aBusyArchiveRangeRetriesAndThenLoads() async throws {
    let server = FakeServer()
    let controller = ReplayController(target: ReplayTarget(archive: "ended", platform: "ios"))
    let loaded = controller.connect(server)
    await settle()
    try #require(server.take("replay.range")).reply.resume(
      throwing: ServerError(code: "limit-exceeded", message: "A connection can run 4 requests at a time."))
    var pending = server.take("replay.range")
    for _ in 0..<100 where pending == nil {
      try await Task.sleep(for: .milliseconds(50))
      pending = server.take("replay.range")
    }
    let retry = try #require(pending)
    #expect(controller.error == nil)
    retry.reply.resume(
      returning: .object(["enabled": .bool(true), "recording": .bool(false), "spans": .array([]), "markers": .array([])]))
    await loaded?.value
    #expect(controller.range != nil && controller.error == nil)
    controller.stop()
  }

  @MainActor @Test func archiveReplayRangeAndFramesNeverTargetALiveWorkspace() async throws {
    let server = FakeServer()
    let target = ReplayTarget(archive: "ended", platform: "web")
    let controller = ReplayController(target: target, scheduler: { _, _ in {} })
    controller.connect(server)
    await settle()
    let request = try #require(server.take("replay.range"))
    #expect(request.params == ["archive": .string("ended"), "platform": .string("web"), "slot": .string("default")])
    request.reply.resume(throwing: ServerError(code: "bad-request", message: "params.workspace is required."))
    await settle()
    #expect(controller.error == "Update stim-server to view archived replay")
    controller.seek(at: 1234, rate: 0)
    let sub = try #require(server.subs.first)
    #expect(sub.params()["archive"] == .string("ended"))
    #expect(sub.params()["workspace"] == nil)
    #expect(sub.params()["at"] == .number(1234))
    controller.live()
    #expect(controller.replay != nil)
    controller.stop()
  }
}
