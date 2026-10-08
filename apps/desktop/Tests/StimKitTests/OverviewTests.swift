import Foundation
import Testing

@testable import StimKit

struct OverviewTests {
  func workspace(_ path: String, fields: String = "") throws -> Workspace {
    try JSONDecoder().decode(
      Workspace.self, from: Data("{\"path\":\"\(path)\",\"live\":false,\"warnings\":[]\(fields)}".utf8))
  }

  func build(_ status: String, at: String) -> String {
    "{\"platform\":\"ios\",\"status\":\"\(status)\",\"cacheHit\":\"none\",\"startedAt\":\"\(at)\",\"finishedAt\":\"\(at)\"}"
  }

  func pullRequest(_ state: String) -> String {
    ",\"worktree\":{\"path\":\"/w\",\"pullRequest\":{\"number\":7,\"url\":\"u\",\"title\":\"t\",\"state\":\"\(state)\"}}"
  }

  func projectOf(_ path: String) -> Project { Project(root: String(path.prefix(while: { $0 != "#" }))) }

  @Test func listsIdleProjectsNewestActivityFirstWithTheirPullRequestFailureAndErrors() throws {
    let old = try workspace(
      "/a#1", fields: ",\"lastBuilds\":{\"ios\":\(build("ok", at: "2026-10-01T10:00:00Z"))}")
    let recent = try workspace(
      "/b#1",
      fields:
        ",\"lastBuilds\":{\"ios\":\(build("failed", at: "2026-10-05T10:00:00Z"))},\"logs\":{\"dir\":\"/l\",\"errorsSinceMarker\":3}"
        + pullRequest("draft"))
    let merged = try workspace("/c#1", fields: pullRequest("merged"))
    let summaries = ["/a", "/b", "/c", "/d"].map { ProjectSummary(project: Project(root: $0), live: 0, total: 1) }
    let idle = Overview.idleProjects(
      summaries: summaries, environments: [old, recent, merged], project: projectOf)
    #expect(idle.map(\.project.root) == ["/b", "/a", "/c", "/d"])
    #expect(idle[0].pullRequest?.state == "draft")
    #expect(idle[0].failedBuild?.status == "failed")
    #expect(idle[0].errors == 3)
    #expect(idle[1].failedBuild == nil)
    #expect(idle[2].pullRequest == nil)
    #expect(idle[3].lastActivity == nil)
  }

  @Test func leavesActiveProjectsOutOfTheIdleList() throws {
    var active = ProjectSummary(project: Project(root: "/a"), live: 1, total: 1)
    active.active = 1
    let idle = Overview.idleProjects(
      summaries: [active, ProjectSummary(project: Project(root: "/b"), live: 0, total: 1)], environments: [],
      project: projectOf)
    #expect(idle.map(\.project.root) == ["/b"])
  }

  func idleItems(_ count: Int) -> [IdleProject] {
    (0..<count).map {
      IdleProject(
        project: Project(root: "/p\($0)"), workspaces: 1, lastActivity: nil, pullRequest: nil, failedBuild: nil, errors: 0)
    }
  }

  @Test func showsTheFirstIdleProjectsUntilExpanded() {
    let limit = Overview.idleShown
    let few = idleItems(limit)
    #expect(Overview.visibleIdle(few, expanded: false) == (few, 0))
    let many = idleItems(limit + 14)
    let collapsed = Overview.visibleIdle(many, expanded: false)
    #expect(collapsed.shown == Array(many.prefix(limit)))
    #expect(collapsed.hidden == 14)
    let expanded = Overview.visibleIdle(many, expanded: true)
    #expect(expanded.shown == many)
    #expect(expanded.hidden == 0)
  }
}

struct ProjectPageTests {
  func workspace(_ path: String, live: Bool) throws -> Workspace {
    try JSONDecoder().decode(
      Workspace.self, from: Data("{\"path\":\"\(path)\",\"live\":\(live),\"warnings\":[]}".utf8))
  }

  @Test func showsAllWorktreesOnlyForTheProjectOpenedFromAnIdleRow() {
    let opened = Project(root: "/a")
    #expect(ProjectPage.scope(of: opened, showingAll: opened) == .all)
    #expect(ProjectPage.scope(of: opened, showingAll: Project(root: "/b")) == .active)
    #expect(ProjectPage.scope(of: opened, showingAll: nil) == .active)
  }

  @Test func listsActiveWorktreesFirstAndOnlyThemUnlessShowingAll() throws {
    let idle = try workspace("/a#1", live: false)
    let running = try workspace("/a#2", live: true)
    #expect(ProjectPage.content(environments: [idle, running], scope: .active) == .worktrees([running]))
    #expect(ProjectPage.content(environments: [idle, running], scope: .all) == .worktrees([running, idle]))
  }

  @Test func namesTheFilterWhenEveryWorktreeIsFilteredOut() throws {
    let idle = try workspace("/a#1", live: false)
    #expect(ProjectPage.content(environments: [idle], scope: .active) == .noneActive)
    #expect(ProjectPage.content(environments: [idle], scope: .all) == .worktrees([idle]))
    #expect(ProjectPage.content(environments: [], scope: .active) == .empty)
    #expect(ProjectPage.content(environments: [], scope: .all) == .empty)
  }
}

struct TryThisTests {
  func inputs(_ edit: (inout TryThisInputs) -> Void = { _ in }) -> TryThisInputs {
    var inputs = TryThisInputs()
    inputs.remoteMachines = []
    edit(&inputs)
    return inputs
  }

  func workspace(_ fields: String) throws -> Workspace {
    try JSONDecoder().decode(
      Workspace.self, from: Data("{\"path\":\"/w\",\"live\":true,\"warnings\":[]\(fields)}".utf8))
  }

  @Test func suggestsEASOnlyForAProjectWithAnEASConfigAndMacOSOnlyForASwiftPackageApp() {
    let plain = inputs()
    #expect(![TryThisTip.easProfile, .easSimulator, .macos].contains { TryThis.applicable($0, inputs: plain) })
    let project = inputs {
      $0.hasEASProject = true
      $0.hasMacosTarget = true
    }
    #expect([TryThisTip.easProfile, .easSimulator, .macos].allSatisfy { TryThis.applicable($0, inputs: project) })
  }

  let calendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    return calendar
  }()

  func date(_ day: Int, hour: Int = 9) -> Date {
    calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour))!
  }

  func select(
    _ inputs: TryThisInputs, dismissed: Set<TryThisTip> = [], sidebar: TipTopic? = nil, state: inout TryThisState,
    at now: Date
  ) -> TryThisTip? {
    let tip = TryThis.select(
      inputs: inputs, dismissed: dismissed, sidebarTopic: sidebar, state: state, now: now, calendar: calendar)
    if let tip { TryThis.record(tip, state: &state, now: now, calendar: calendar) }
    return tip
  }

  @Test func offersNoRemoteMacTipOnceRemoteMachinesIsSetOrUnreadable() {
    for machines in [["mini"], nil] as [[String]?] {
      let tips = TryThis.candidates(
        inputs: inputs { $0.remoteMachines = machines }, dismissed: [], sidebarTopic: nil)
      #expect(!tips.contains(.remoteBuild) && !tips.contains(.hostedSimulator))
    }
  }

  @Test func suggestsRunningOnAPhysicalDeviceWithoutTheStimMobileApp() {
    #expect(TryThis.applicable(.physicalDevice, inputs: inputs()))
    #expect(TryThis.candidates(inputs: inputs(), dismissed: [], sidebarTopic: nil).contains(.physicalDevice))
  }

  @Test func keepsTheSameTipAllDayAndRotatesToTheLeastRecentlyShownTheNextDay() {
    var state = TryThisState()
    let all = inputs()
    let candidates = TryThis.candidates(inputs: all, dismissed: [], sidebarTopic: nil)
    let first = select(all, state: &state, at: date(8))
    #expect(first == candidates.first)
    #expect(select(all, state: &state, at: date(8, hour: 23)) == first)
    var seen = [first]
    for day in 9..<(8 + candidates.count) { seen.append(select(all, state: &state, at: date(day))) }
    #expect(Set(seen.compactMap { $0 }).count == candidates.count)
    #expect(select(all, state: &state, at: date(8 + candidates.count)) == first)
  }

  @Test func replacesTodaysTipOnlyWhenItStopsBeingACandidate() {
    var state = TryThisState()
    let withEAS = inputs { $0.hasEASProject = true }
    TryThis.record(.easProfile, state: &state, now: date(8), calendar: calendar)
    #expect(select(withEAS, state: &state, at: date(8, hour: 12)) == .easProfile)
    #expect(select(inputs(), state: &state, at: date(8, hour: 13)) != .easProfile)
  }

  @Test func showsTheNextTipRightAwayAfterADismissalAndSkipsTheSidebarsTip() {
    var state = TryThisState()
    let all = inputs()
    let first = select(all, state: &state, at: date(8))!
    let second = select(all, dismissed: [first], state: &state, at: date(8, hour: 10))
    #expect(second != nil && second != first)
    let sidebar = TryThisTip.allCases.first { $0.sidebarTopic != nil }!
    state = TryThisState()
    state.current = .init(tip: sidebar, day: "2026-10-08")
    let picked = select(all, sidebar: sidebar.sidebarTopic, state: &state, at: date(8))
    #expect(picked != sidebar)
    #expect(select(all, dismissed: Set(TryThisTip.allCases), state: &state, at: date(8)) == nil)
  }

  @Test func nextTipFollowsTheCatalogAndNeverReturnsTheSidebarsTip() {
    let all = inputs()
    let catalog = TryThis.candidates(inputs: all, dismissed: [], sidebarTopic: .buildMachine)
    #expect(!catalog.contains(.remoteBuild))
    #expect(TryThis.next(after: catalog[0], inputs: all, dismissed: [], sidebarTopic: .buildMachine) == catalog[1])
    #expect(TryThis.next(after: .remoteBuild, inputs: all, dismissed: [], sidebarTopic: .buildMachine) == .hostedSimulator)
    let only = Set(TryThisTip.allCases).subtracting([.web])
    #expect(TryThis.next(after: .web, inputs: all, dismissed: only, sidebarTopic: nil) == nil)
  }

  @Test func prefersFeaturesNotYetUsedAndRemembersTheStateAcrossLaunches() throws {
    let usedWeb = try workspace(
      ",\"web\":{\"running\":true,\"url\":\"http://localhost:8081/\",\"headless\":true,\"viewport\":\"1x1\",\"profile\":\"p\"}")
    var tips = inputs { $0.workspaces = [usedWeb] }
    tips.remoteMachines = []
    var state = TryThisState()
    for day in 8..<20 { #expect(select(tips, state: &state, at: date(day)) != .web) }
    let onlyWeb = Set(TryThisTip.allCases).subtracting([.web])
    #expect(select(tips, dismissed: onlyWeb, state: &state, at: date(21)) == .web)

    let name = "TryThisTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    TryThisStore(defaults: defaults).state = state
    #expect(TryThisStore(defaults: defaults).state == state)
  }

  @Test func readsWhichFeaturesTheWorkspacesAlreadyUse() throws {
    let offloaded = try workspace(
      ",\"lastBuilds\":{\"ios\":{\"platform\":\"ios\",\"status\":\"ok\",\"cacheHit\":\"none\",\"startedAt\":\"2026-10-06T10:00:00Z\",\"offloadedTo\":\"mini\"}}"
    )
    #expect(TryThis.used(.remoteBuild, workspaces: [offloaded]))
    #expect(!TryThis.used(.remoteBuild, workspaces: [try workspace("")]))
    #expect(!TryThis.used(.macos, workspaces: [offloaded]))
  }

  @Test func remembersDismissedTips() {
    let name = "TryThisTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    let store = TryThisStore(defaults: defaults)
    store.dismiss(.web)
    store.dismiss(.macos)
    #expect(TryThisStore(defaults: defaults).dismissed == [.web, .macos])
  }
}

struct ProjectCapabilitiesTests {
  func project(_ files: [String: String]) throws -> String {
    let root = NSTemporaryDirectory() + "caps-\(UUID().uuidString)"
    for (path, text) in files {
      let file = root + "/" + path
      try FileManager.default.createDirectory(
        atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
      try text.write(toFile: file, atomically: true, encoding: .utf8)
    }
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    return root
  }

  @Test func findsAnEASConfigAndASwiftPackageAppAtTheRootOrUnderApps() throws {
    let root = try project([
      "apps/mobile/eas.json": "{}",
      "apps/desktop/Package.swift": "let package = Package(targets: [.executableTarget(name: \"App\")])",
    ])
    defer { try? FileManager.default.removeItem(atPath: root) }
    #expect(ProjectCapabilities.detect(root: root) == ProjectCapabilities(eas: true, macos: true))
  }

  @Test func reportsNothingForAPlainProjectAndALibraryPackage() throws {
    let root = try project(["Package.swift": "let package = Package(targets: [.target(name: \"Lib\")])"])
    defer { try? FileManager.default.removeItem(atPath: root) }
    #expect(ProjectCapabilities.detect(root: root) == ProjectCapabilities())
    #expect(ProjectCapabilities.detect(root: root + "/missing") == ProjectCapabilities())
  }
}
