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
    let shared = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        #"[{"path":"/r/app/.worktrees/idle","live":false,"warnings":[]},{"path":"/r/app/.worktrees/live","live":true,"warnings":[]},{"path":"/r/app/.worktrees/z/apps/a","live":false,"hidden":true,"warnings":[],"worktree":{"path":"/r/app/.worktrees/z","branch":"z"}},{"path":"/r/app/.worktrees/z/apps/b","live":false,"warnings":[],"worktree":{"path":"/r/app/.worktrees/z","branch":"z"}}]"#
          .utf8))
    let normal = sidebarList(environments: shared, unprovisioned: [], project: project, options: SidebarOptions())
    #expect(normal.map(\.path).contains(shared[3].path))
    #expect(!normal.map(\.path).contains(shared[2].path))
    var onlyHidden = SidebarOptions()
    onlyHidden.statuses = [.hidden]
    let hiddenRows = sidebarList(environments: shared, unprovisioned: [], project: project, options: onlyHidden)
    #expect(hiddenRows.map(\.path) == [shared[2].path])
    let counts = sidebarStatusCounts(environments: shared, unprovisioned: [], project: project, options: onlyHidden)
    #expect(counts[.hidden] == 1 && counts[.idle] == 2 && counts[.live] == 1)
    onlyHidden.statuses = StatusFilter.all.union([.hidden])
    let combined = sidebarList(environments: shared, unprovisioned: [], project: project, options: onlyHidden)
    #expect(Set(combined.map(\.id)).count == combined.count)
    #expect(
      combined.contains {
        if case .worktreeGroup(let page) = $0 { return page.apps.map(\.path) == [shared[2].path, shared[3].path] }
        return false
      })
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

  @Test func knownLocalPathsWaitForTheirReportedSharedState() throws {
    let envs = try environments()
    let hidden = HiddenWorkspaces(paths: [envs[0].path, envs[1].path, "/unknown"])
    let kept = hidden.reconciled(environments: envs, unprovisioned: nil, archived: nil, isBusy: { _ in false })
    #expect(kept.paths == [envs[0].path, "/unknown"])
    let migration = kept.migrations(environments: envs)
    #expect(migration.map(\.path) == [envs[0].path])
    #expect(migration.map(\.hidden) == [true])
    var missing = envs[0]
    missing.pathMissing = true
    missing.checkout = nil
    missing.worktree = nil
    let local = HiddenWorkspaces(paths: [missing.path])
    #expect(local.migrations(environments: [missing]).isEmpty)
    #expect(local.reconciled(environments: [missing], unprovisioned: nil, archived: nil, isBusy: { _ in false }) == local)
    for busyKey in [missing.path, missing.worktreeActionKey] {
      #expect(local.reconciled(environments: [missing], unprovisioned: nil, archived: nil, isBusy: { $0 == busyKey }).isEmpty)
    }
    missing.live = true
    #expect(local.reconciled(environments: [missing], unprovisioned: nil, archived: nil, isBusy: { _ in false }).isEmpty)
  }

  @Test func eachKindOfRealActivityMigratesAsVisible() throws {
    func migrating(_ json: String) throws -> Bool {
      let envs = try JSONDecoder().decode([Workspace].self, from: Data(json.utf8))
      return try #require(HiddenWorkspaces(paths: ["/w"]).migrations(environments: envs).first).hidden
    }
    #expect(try migrating(#"[{"path":"/w","live":false,"warnings":[]}]"#))
    #expect(try !migrating(#"[{"path":"/w","live":true,"warnings":[]}]"#))
    #expect(
      try !migrating(
        #"[{"path":"/w","live":false,"warnings":[],"build":{"platform":"ios","slot":"default","state":"running","phase":"install","startedAt":"2026-10-06T00:00:00Z","phaseStartedAt":"2026-10-06T00:00:00Z","basis":0}}]"#
      ))
    #expect(try !migrating(#"[{"path":"/w","live":false,"warnings":[],"phase":"warming"}]"#))
  }

  @Test func recentIdleActivityDoesNotClearTheMigration() throws {
    let envs = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        #"[{"path":"/w","live":false,"warnings":[],"supervisor":{"startedAt":"2099-01-01T00:00:00Z"},"lastBuilds":{"ios":{"platform":"ios","status":"ok","cacheHit":"local","startedAt":"2099-01-01T00:00:00Z","finishedAt":"2099-01-01T00:05:00Z"}}}]"#
          .utf8))
    let migration = try #require(HiddenWorkspaces(paths: ["/w"]).migrations(environments: envs).first)
    #expect(migration.hidden)
  }

  @Test func aLegacyGroupMigratesEveryAppAndStaysVisibleIfAnyIsActive() throws {
    var envs = try environments()
    let hidden = HiddenWorkspaces(paths: [envs[2].path])
    let idle = try #require(hidden.migrations(environments: envs).first)
    #expect(idle.apps.map(\.path) == [envs[2].path, envs[3].path] && idle.hidden)
    func reconciled(_ value: HiddenWorkspaces) -> HiddenWorkspaces {
      value.reconciled(environments: envs, unprovisioned: nil, archived: nil, isBusy: { _ in false })
    }
    envs[2].hidden = true
    #expect(reconciled(hidden) == hidden)
    envs[3].hidden = true
    let completed = reconciled(hidden)
    #expect(completed.isEmpty)
    envs[2].hidden = nil
    envs[3].hidden = nil
    #expect(!reconciled(completed).contains(.workspace(envs[2])))
    envs[3].live = true
    let active = try #require(hidden.migrations(environments: envs).first)
    #expect(active.apps.map(\.path) == idle.apps.map(\.path) && !active.hidden)
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
