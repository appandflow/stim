import Foundation
import Testing

@testable import StimKit

@Suite struct ArchivedPageTests {
  private let now = Date(timeIntervalSince1970: 1791288000)

  private func archive() throws -> ArchivedWorkspace {
    let data = try Data(contentsOf: Bundle.module.url(forResource: "Fixtures/archived-status.json", withExtension: nil)!)
    return try #require(JSONDecoder().decode(StatusPayload.self, from: data).archived?.first)
  }

  private func detail() throws -> ArchiveDetail {
    try JSONDecoder().decode(
      ArchiveDetail.self,
      from: Data(
        #"""
        {"builds":{"ios":[
          {"platform":"ios","status":"failed","cacheHit":false,"startedAt":"2026-10-04T10:00:00Z",
           "finishedAt":"2026-10-04T10:00:42Z","result":"failed","slot":"default","configuration":"Debug",
           "phases":{"prepare":1000,"compile":41000},"errorCode":"STIM_IOS_BUILD_FAILED"}],
         "android":[
          {"platform":"android","status":"ok","cacheHit":"local","startedAt":"2026-10-04T09:00:00Z",
           "result":"succeeded","slot":"fold","phases":{"install":2000,"launch":1000}}]},
         "recordings":[{"platform":"ios","slot":"default","spans":[{"start":1000,"end":2000}]},
                       {"platform":"android","slot":"fold","spans":[{"start":3000,"end":4000}]}]}
        """#.utf8))
  }

  @Test func archivedPageRetainsWorkAndBuildHistoryWithoutLiveState() throws {
    let page = ArchivedPage(archive: try archive(), detail: try detail(), now: now)
    let workspace = page.workspace
    #expect(workspace.path == "/work/feature/app")
    #expect(workspace.names.title == "feature-search")
    #expect(workspace.lastBuilds?.ios?.status == "failed")
    #expect(workspace.lastBuilds?.android?.cacheHit == .local)
    #expect(workspace.builds?.ios?.first?.phases == ["prepare": 1000, "compile": 41000])
    #expect(workspace.worktree?.branch == "feature-search")
    #expect(workspace.worktree?.pullRequest?.number == 2602)
    #expect(workspace.worktree?.pullRequest?.state == "merged")
    #expect(workspace.worktree?.merged == true)
    #expect(page.merged)
    #expect(workspace.endedAgents?.first?.sessionId == "ended-session")
    #expect(workspace.endedAgents?.first?.duration == 7200)
    #expect(workspace.agents == nil)
    #expect(!workspace.live && !workspace.isActive)
    #expect(workspace.devices.isEmpty)
    #expect(workspace.metro == nil && workspace.supervisor == nil)
    #expect(workspace.memoryMb == nil && workspace.disk == nil)
    #expect(page.statusLine == "Removed 2d ago by worktree removal")
    #expect(page.lastUsedLabel != nil)
    #expect(page.sizeLabel == Format.fileSize(3147776))
    #expect(page.replacedBy == "/work/new/app")
    #expect(page.recordings.map(\.slot) == ["default", "fold"])
    #expect(page.recordings[1].spans == [ReplaySpan(start: 3000, end: 4000)])
  }

  @Test func missingDetailKeepsLastBuildSummaryForDisconnectedOrOlderServers() throws {
    let archive = try archive()
    let page = ArchivedPage(archive: archive, now: now)
    #expect(page.workspace.lastBuilds?.ios == archive.builds.last)
    #expect(page.workspace.lastBuilds?.android == nil)
    #expect(page.workspace.builds == nil)
    #expect(page.workspace.runPlatforms == ["ios"])
    #expect(page.recordings.isEmpty)
  }

  @Test func anArchiveWithoutBuildsDoesNotInventPlatformsOrHistory() throws {
    var archive = try archive()
    archive.builds.last = nil
    archive.builds.count = 0
    archive.worktree.branch = nil
    let page = ArchivedPage(archive: archive, now: now)
    #expect(page.workspace.lastBuilds?.ios == nil && page.workspace.lastBuilds?.android == nil)
    #expect(page.workspace.builds == nil)
    #expect(page.workspace.runPlatforms.isEmpty)
    #expect(page.workspace.names.title == "app")
    let empty = try JSONDecoder().decode(ArchiveDetail.self, from: Data(#"{"builds":{},"recordings":[]}"#.utf8))
    #expect(ArchivedPage(archive: try self.archive(), detail: empty, now: now).workspace.runPlatforms.isEmpty)
  }

  @Test func mergedPullRequestIsRetainedEvenWithoutTheWorktreeMergeFlag() throws {
    var archive = try archive()
    archive.worktree.merged = nil
    #expect(ArchivedPage(archive: archive, now: now).merged)
    archive.worktree.pullRequest = nil
    archive.worktree.merged = true
    #expect(ArchivedPage(archive: archive, now: now).merged)
    archive.worktree.merged = false
    #expect(!ArchivedPage(archive: archive, now: now).merged)
  }

  @Test func retainedContentExpiresOnlyWithZeroBytesOrAPastDeadline() throws {
    var archive = try archive()
    for offset in [-1.0, 0.0, 1.0] {
      archive.expires.logs = now.addingTimeInterval(offset).ISO8601Format()
      archive.expires.recordings = archive.expires.logs
      let page = ArchivedPage(archive: archive, detail: try detail(), now: now)
      #expect(page.logsExpired == (offset < 0))
      #expect(page.recordingsExpired == (offset < 0))
    }
    archive.expires.logs = nil
    archive.expires.recordings = nil
    var page = ArchivedPage(archive: archive, now: now)
    #expect(!page.logsExpired && !page.recordingsExpired)
    archive.bytes.logs = 0
    archive.bytes.recordings = 0
    archive.expires.logs = now.addingTimeInterval(86400).ISO8601Format()
    archive.expires.recordings = archive.expires.logs
    page = ArchivedPage(archive: archive, now: now)
    #expect(page.logsExpired && page.recordingsExpired)
  }
  @Test(arguments: ["draft", "open", "closed"])
  func snapshotPullRequestStatesNeverPretendToBeCurrent(_ state: String) throws {
    var archive = try archive()
    archive.worktree.merged = nil
    archive.worktree.pullRequest?.state = state
    let page = ArchivedPage(archive: archive, now: now)
    #expect(page.pullRequestLabel == "#2602")
    #expect(page.workspace.worktree?.pullRequest?.state == "")
    #expect(page.workspace.worktree?.pullRequest?.title == archive.worktree.pullRequest?.title)
    archive.worktree.merged = true
    let merged = ArchivedPage(archive: archive, now: now)
    #expect(merged.pullRequestLabel == "#2602 \u{00B7} Merged")
    #expect(merged.workspace.worktree?.pullRequest?.state == "merged")
  }

  @Test func retentionWarnsWithin24HoursAndKeepsEveryStorageKind() throws {
    var archive = try archive()
    archive.expires.logs = now.addingTimeInterval(86400).ISO8601Format()
    archive.expires.recordings = now.addingTimeInterval(86401).ISO8601Format()
    archive.expires.agentActions = now.addingTimeInterval(-1).ISO8601Format()
    let page = ArchivedPage(archive: archive, now: now)
    #expect(page.expiryLabel == "Expires soon")
    #expect(page.retention.map(\.bytes) == [1048576, 2097152, 1024, 1024])
    #expect(page.retention.map(\.expiresSoon) == [true, false, false, false])
    #expect(page.retention.map(\.expired) == [false, false, true, false])
    let withHistory = ArchivedPage(archive: archive, detail: try detail(), now: now)
    #expect(withHistory.cacheHits == 1)
    #expect(withHistory.offloadedBuilds == 0)
    #expect(page.cacheHits == nil && page.offloadedBuilds == nil)
  }

  @Test func nestedAppsRetainWorktreeIdentityEvenAfterGitFactsAreGone() throws {
    var archive = try archive()
    archive.worktree.branch = nil
    archive.worktree.repository = nil
    for root in ["/work/stim/.worktrees/missing", "/work/stim/.claude/worktrees/missing", "/work/missing"] {
      archive.projectRoot = root + "/apps/mobile"
      let page = ArchivedPage(archive: archive, now: now)
      #expect(page.workspace.worktree?.path == root)
      #expect(page.workspace.names.title == "missing")
      #expect(page.workspace.names.inCheckout == "apps/mobile")
    }
  }

}
