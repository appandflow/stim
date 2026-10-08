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

  @Test func offersNoRemoteMacTipOnceRemoteMachinesIsSetOrUnreadable() {
    for machines in [["mini"], nil] as [[String]?] {
      let tips = TryThis.select(
        inputs: inputs { $0.remoteMachines = machines }, dismissed: [], sidebarTopic: nil)
      #expect(!tips.contains(.remoteBuild) && !tips.contains(.hostedSimulator))
    }
  }

  @Test func hidesThePhoneTipWithoutThePhoneAppFlag() {
    #expect(!TryThis.applicable(.physicalDevice, inputs: inputs()))
    #expect(TryThis.applicable(.physicalDevice, inputs: inputs { $0.phoneApp = true }))
  }

  @Test func skipsDismissedTipsAndTheOneTheSidebarShows() {
    let tips = TryThis.select(inputs: inputs(), dismissed: [.web], sidebarTopic: .buildMachine)
    #expect(!tips.contains(.web) && !tips.contains(.remoteBuild))
    #expect(tips.contains(.hostedSimulator))
  }

  @Test func showsAtMostThreePreferringFeaturesNotYetUsed() throws {
    let usedWeb = try workspace(
      ",\"web\":{\"running\":true,\"url\":\"http://localhost:8081/\",\"headless\":true,\"viewport\":\"1x1\",\"profile\":\"p\"}")
    var tips = inputs { $0.workspaces = [usedWeb] }
    tips.remoteMachines = []
    let picked = TryThis.select(inputs: tips, dismissed: [], sidebarTopic: nil)
    #expect(picked.count == 3)
    #expect(!picked.contains(.web))
    let onlyWeb = TryThis.select(inputs: tips, dismissed: Set(TryThisTip.allCases).subtracting([.web]), sidebarTopic: nil)
    #expect(onlyWeb == [.web])
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
