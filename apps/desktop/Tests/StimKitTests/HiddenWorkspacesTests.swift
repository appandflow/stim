import Foundation
import Testing

@testable import StimKit

@Suite struct HiddenWorkspacesTests {
  private let project: (String) -> Project = { Project(fallbackFor: $0) }

  private func environments() throws -> [Workspace] {
    try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        """
        [{"path":"/r/app/.worktrees/idle","live":false,"warnings":[]},
         {"path":"/r/app/.worktrees/live","live":true,"warnings":[]},
         {"path":"/r/app/.worktrees/z/apps/a","live":false,"warnings":[],"worktree":{"path":"/r/app/.worktrees/z","branch":"z"}},
         {"path":"/r/app/.worktrees/z/apps/b","live":false,"warnings":[],"worktree":{"path":"/r/app/.worktrees/z","branch":"z"}}]
        """.utf8))
  }

  private func archives() throws -> [ArchivedWorkspace] {
    let url = try #require(Bundle.module.url(forResource: "Fixtures/archived-status.json", withExtension: nil))
    var archive = try #require(try JSONDecoder().decode(StatusPayload.self, from: Data(contentsOf: url)).archived?.first)
    archive.worktree.repository = "/r/app"
    var other = archive
    archive.id = "a1"
    other.id = "a2"
    other.projectRoot = "/r/app/.worktrees/other"
    return [archive, other]
  }

  private let worktrees = [UnprovisionedWorktree(path: "/r/app/.worktrees/new", branch: nil)]

  private func list(_ statuses: Set<StatusFilter>, hidden: HiddenWorkspaces) throws -> [String] {
    var options = SidebarOptions()
    options.statuses = statuses
    options.hiddenWorkspaces = hidden
    return sidebarList(
      environments: try environments(), unprovisioned: worktrees, project: project, options: options,
      archived: try archives()
    ).map(\.id)
  }

  @Test func hidingAndUnhidingRoundTripsThroughItsStoredForm() {
    var hidden = HiddenWorkspaces().setting(path: "/r/a", hidden: true).setting(archives: ["x", "y"], hidden: true)
    #expect(HiddenWorkspaces.decode(HiddenWorkspaces.encode(hidden)) == hidden)
    hidden = hidden.setting(path: "/r/a", hidden: false).setting(archives: ["x"], hidden: false)
    #expect(hidden == HiddenWorkspaces(archives: ["y"]))
    #expect(HiddenWorkspaces.encode(HiddenWorkspaces()) == "")
    #expect(HiddenWorkspaces.decode("not json") == HiddenWorkspaces())
  }

  @Test func hiddenRowsLeaveEveryStatusAndShowOnlyUnderHidden() throws {
    let hidden = HiddenWorkspaces(
      paths: ["/r/app/.worktrees/idle", "/r/app/.worktrees/z/apps/a", "/r/app/.worktrees/new"], archives: ["a1"])
    let everything = StatusFilter.all
    let shown = try list(everything, hidden: hidden)
    #expect(shown == ["/r/app/.worktrees/live", "archive:a2"])
    #expect(
      try list([.hidden], hidden: hidden).sorted()
        == ["/r/app/.worktrees/idle", "/r/app/.worktrees/new", "/r/app/.worktrees/z/apps/a", "archive:a1"])
    #expect(try list(everything.union([.hidden]), hidden: hidden).count == 6)
    #expect(try list(everything, hidden: HiddenWorkspaces()).count == 6)
    #expect(!StatusFilter.all.contains(.hidden))
    #expect(!StatusFilter.defaultSelection.contains(.hidden))
  }

  @Test func hidingOneArchiveOfAGroupSplitsItFromTheRest() throws {
    var records = try archives()
    records[1].projectRoot = "/r/app/.worktrees/other/apps/two"
    records[0].projectRoot = "/r/app/.worktrees/other/apps/one"
    func rows(_ hidden: HiddenWorkspaces, _ statuses: Set<StatusFilter>) -> [String] {
      var options = SidebarOptions()
      options.statuses = statuses
      options.hiddenWorkspaces = hidden
      return sidebarList(
        environments: [], unprovisioned: [], project: project, options: options, archived: records
      ).map(\.id)
    }
    #expect(rows(HiddenWorkspaces(), [.archived]).count == 1)
    #expect(rows(HiddenWorkspaces(archives: ["a1"]), [.archived]) == ["archive:a2"])
    #expect(rows(HiddenWorkspaces(archives: ["a1"]), [.hidden]) == ["archive:a1"])
  }

  @Test func theWorktreeActionKeyMatchesItsPage() throws {
    for env in try environments() {
      #expect(env.worktreeActionKey == WorktreePage.groups(environments: [env])[0].actionKey)
    }
  }

  @Test func countsPutHiddenRowsUnderHiddenOnly() throws {
    var options = SidebarOptions()
    options.hiddenWorkspaces = HiddenWorkspaces(paths: ["/r/app/.worktrees/idle", "/r/app/.worktrees/new"], archives: ["a2"])
    let counts = sidebarStatusCounts(
      environments: try environments(), unprovisioned: worktrees, project: project, options: options,
      archived: try archives())
    #expect(counts[.hidden] == 3)
    #expect(counts[.live] == 1)
    #expect(counts[.idle] == 1)
    #expect(counts[.notSetUp] == 0)
    #expect(counts[.archived] == 1)
  }

  @Test func statusSummaryNamesHidden() {
    #expect(StatusFilter.summary([.hidden]) == "Hidden")
    #expect(StatusFilter.summary(StatusFilter.all.union([.hidden])) == "All + Hidden")
  }

  @Test func aWorkspaceThatBecomesActiveIsShownAgain() throws {
    let hidden = HiddenWorkspaces(paths: ["/r/app/.worktrees/live", "/r/app/.worktrees/idle"])
    let reconciled = hidden.reconciled(
      environments: try environments(), unprovisioned: worktrees, archived: [], isBusy: { _ in false })
    #expect(reconciled.paths == ["/r/app/.worktrees/idle"])
  }

  @Test func eachKindOfRealActivityUnhides() throws {
    func reconcile(_ json: String, busy: Set<String> = []) throws -> Set<String> {
      let envs = try JSONDecoder().decode([Workspace].self, from: Data(json.utf8))
      return HiddenWorkspaces(paths: ["/w"]).reconciled(
        environments: envs, unprovisioned: [], archived: [], isBusy: { busy.contains($0) }
      ).paths
    }
    #expect(try reconcile(#"[{"path":"/w","live":false,"warnings":[]}]"#) == ["/w"])
    #expect(try reconcile(#"[{"path":"/w","live":true,"warnings":[]}]"#).isEmpty)
    #expect(
      try reconcile(
        #"[{"path":"/w","live":false,"warnings":[],"build":{"platform":"ios","slot":"default","state":"running","phase":"install","startedAt":"2026-10-06T00:00:00Z","phaseStartedAt":"2026-10-06T00:00:00Z","basis":0}}]"#
      ).isEmpty)
    #expect(try reconcile(#"[{"path":"/w","live":false,"warnings":[],"phase":"warming"}]"#).isEmpty)
    #expect(try reconcile(#"[{"path":"/w","live":false,"warnings":[]}]"#, busy: ["/w"]).isEmpty)
  }

  @Test func recentIdleActivityDoesNotUnhide() throws {
    let envs = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        #"[{"path":"/w","live":false,"warnings":[],"supervisor":{"startedAt":"2099-01-01T00:00:00Z"},"lastBuilds":{"ios":{"platform":"ios","status":"ok","cacheHit":"local","startedAt":"2099-01-01T00:00:00Z","finishedAt":"2099-01-01T00:05:00Z"}}}]"#
          .utf8))
    let kept = HiddenWorkspaces(paths: ["/w"]).reconciled(
      environments: envs, unprovisioned: [], archived: [], isBusy: { _ in false })
    #expect(kept.paths == ["/w"])
  }

  @Test func aGroupUnhidesWhenAnyAppIsActive() throws {
    var envs = try environments()
    let hidden = HiddenWorkspaces(paths: [envs[2].path])
    #expect(
      hidden.reconciled(environments: envs, unprovisioned: [], archived: [], isBusy: { _ in false }).paths == [envs[2].path])
    envs[3].live = true
    #expect(hidden.reconciled(environments: envs, unprovisioned: [], archived: [], isBusy: { _ in false }).isEmpty)
  }

  @Test func entriesForWorkspacesThatExistNowhereAreForgotten() throws {
    let hidden = HiddenWorkspaces(
      paths: ["/r/app/.worktrees/idle", "/r/app/.worktrees/new", "/gone"], archives: ["a1", "deleted"])
    let reconciled = hidden.reconciled(
      environments: try environments(), unprovisioned: worktrees, archived: try archives(), isBusy: { _ in false })
    #expect(reconciled.paths == ["/r/app/.worktrees/idle", "/r/app/.worktrees/new"])
    #expect(reconciled.archives == ["a1"])
  }

  @Test func unreportedListsKeepTheirEntries() throws {
    let hidden = HiddenWorkspaces(paths: ["/r/app/.worktrees/new"], archives: ["a1"])
    let reconciled = hidden.reconciled(
      environments: try environments(), unprovisioned: nil, archived: nil, isBusy: { _ in false })
    #expect(reconciled == hidden)
  }
}
