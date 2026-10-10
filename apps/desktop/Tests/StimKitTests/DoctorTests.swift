import Foundation
import StimKit
import Testing

struct DoctorTests {
  @Test func listsCostFindingsAsSetupItemsWithTheirStimRemedy() throws {
    let url = try #require(Bundle.module.url(forResource: "doctor", withExtension: "json", subdirectory: "Fixtures"))
    let report = try JSONDecoder().decode(DoctorReport.self, from: Data(contentsOf: url))
    let items = setupItems([report])
    #expect(
      items.map(\.body) == [
        "Setup: Host memory pressure can stall the iOS simulator",
        "Setup: The configured CMake cache predates the ccache launcher, so C++ compiles still bypass it",
      ])
    #expect(items.map(\.remedy) == ["stim guide lifecycle simslim", "stim doctor --fix --platform android"])
    #expect(items.map(\.runnable) == [false, true])
    #expect(items.allSatisfy { $0.workspace == "/Users/dev/stim/apps/mobile" && $0.category == .attention })
  }

  @Test func takesTheFirstBacktickedStimCommandOnly() {
    #expect(doctorRemedy("Run `npx expo config --json`, then `stim doctor`.") == "stim doctor")
    #expect(doctorRemedy("Free host memory, then retry.") == nil)
    #expect(doctorRemedy(nil) == nil)
  }

  @Test func offersFixOnlyForFindingsThatNameDoctorFix() throws {
    let url = try #require(Bundle.module.url(forResource: "doctor", withExtension: "json", subdirectory: "Fixtures"))
    let report = try #require(DoctorReport.decode(Data(contentsOf: url)))
    #expect(
      report.costFindings.map { $0.repairCommand(cwd: "/p")?.arguments } == [nil, ["doctor", "--fix", "--platform", "android"]])
    #expect(DoctorReport.decode(Data("not json".utf8)) == nil)
  }

  @Test func listsAFailedDoctorRunWithItsMessageAndARunnableRetry() {
    let items = doctorFailureItems(["/b": "stim exited with status 1: error: boom", "/a": "Could not find stim."])
    #expect(items.map(\.workspace) == ["/a", "/b"])
    #expect(
      items.map(\.body) == [
        "stim doctor failed: Could not find stim.", "stim doctor failed: stim exited with status 1: error: boom",
      ])
    #expect(items.map { $0.command?.arguments } == [["doctor"], ["doctor"]])
    #expect(items.allSatisfy { $0.category == .attention && $0.severity == "warning" })
  }

  @Test func runsInTheListedSourceCheckoutElseTheFirstWorktreeOfTheApp() throws {
    let envs = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        #"""
        [{"path":"/r/.worktrees/a/apps/m","live":false,"warnings":[],"worktree":{"path":"/r/.worktrees/a"}},
         {"path":"/r/.worktrees/b/apps/m","live":false,"warnings":[],"worktree":{"path":"/r/.worktrees/b"}},
         {"path":"/r/apps/m","live":false,"warnings":[],"worktree":{"path":"/r"}},
         {"path":"/r/.worktrees/a/apps/w","live":false,"warnings":[],"worktree":{"path":"/r/.worktrees/a"}},
         {"path":"/solo","live":false,"warnings":[]}]
        """#.utf8))
    let checkouts = doctorCheckouts(
      envs, project: { $0 == "/solo" ? Project(root: "/solo") : Project(root: "/r") }, isCheckout: { _ in true })
    #expect(checkouts.map(\.path) == ["/r/apps/m", "/r/.worktrees/a/apps/w", "/solo"])
    #expect(checkouts.map(\.repository) == ["/r", "/r", "/solo"])

    let project = { (path: String) in path == "/solo" ? Project(root: "/solo") : Project(root: "/r") }
    #expect(
      doctorCheckout(for: "/r/.worktrees/a/apps/w", in: envs, project: project, isCheckout: { _ in true })?.path
        == "/r/.worktrees/a/apps/w")
    #expect(
      doctorCheckout(for: "/r/.worktrees/b/apps/m", in: envs, project: project, isCheckout: { _ in true })?.path == "/r/apps/m")
    #expect(doctorCheckout(for: "/solo", in: envs, project: project, isCheckout: { _ in true })?.path == "/solo")
    #expect(doctorCheckout(for: nil, in: envs, project: project, isCheckout: { _ in true })?.path == "/r/apps/m")
    #expect(doctorCheckout(for: "/unlisted", in: envs, project: project, isCheckout: { _ in true })?.path == "/r/apps/m")
  }

  @Test func neverRunsInAScratchFolderAndPrefersTheMostRecentlyActiveApp() throws {
    let envs = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        #"""
        [{"path":"/private/tmp/stim-codex-resume/c/guest-worktree","live":false,"warnings":[],"phaseSince":"2026-10-07T12:00:00Z"},
         {"path":"/tmp/x","live":false,"warnings":[]},
         {"path":"/private/var/folders/ab/T/wt","live":false,"warnings":[]},
         {"path":"/old","live":false,"warnings":[],"phaseSince":"2026-10-01T12:00:00Z"},
         {"path":"/new","live":false,"warnings":[],"phaseSince":"2026-10-06T12:00:00Z"},
         {"path":"/never","live":false,"warnings":[]}]
        """#.utf8))
    let project = { (path: String) in Project(root: path) }
    #expect(doctorCheckouts(envs, project: project, isCheckout: { _ in true }).map(\.path) == ["/new", "/old", "/never"])
    #expect(doctorCheckout(for: "/tmp/x", in: envs, project: project, isCheckout: { _ in true })?.path == "/new")
    #expect(doctorCheckout(for: nil, in: envs, project: project, isCheckout: { _ in true })?.path == "/new")
    #expect(doctorCheckout(for: "/old", in: envs, project: project, isCheckout: { _ in true })?.path == "/old")
    let onlyScratch = Array(envs.prefix(3))
    #expect(doctorCheckout(for: nil, in: onlyScratch, project: project, isCheckout: { _ in true }) == nil)
    #expect(isScratchPath("/private/tmp") && !isScratchPath("/Users/me/tmpfiles/app") && !isScratchPath("/temp/app"))
  }

  @Test func isDueWhenNeverRunNewStimOldRunOrChangedSetup() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let inputs = now.addingTimeInterval(-3600)
    let last = DoctorRun(at: now.addingTimeInterval(-60), version: "1.12.0", inputsChangedAt: inputs)
    #expect(DoctorRun.due(nil, version: "1.12.0", inputsChangedAt: inputs, now: now))
    #expect(!DoctorRun.due(last, version: "1.12.0", inputsChangedAt: inputs, now: now))
    #expect(DoctorRun.due(last, version: "1.13.0", inputsChangedAt: inputs, now: now))
    #expect(DoctorRun.due(last, version: "1.12.0", inputsChangedAt: now, now: now))
    #expect(DoctorRun.due(last, version: "1.12.0", inputsChangedAt: inputs, now: now.addingTimeInterval(8 * 86_400)))
  }

  @Test func skipsWorkspacesWhoseCheckoutIsGoneOrNotGit() throws {
    let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".stim-doctor-test-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let real = root.appendingPathComponent("real")
    let linkedTarget = root.appendingPathComponent("repo/.git/worktrees/live")
    let linked = root.appendingPathComponent("linked/apps/m")
    let stale = root.appendingPathComponent("stale")
    let plain = root.appendingPathComponent("plain")
    for dir in [real.appendingPathComponent(".git"), linkedTarget, linked, stale, plain] {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    try "gitdir: \(linkedTarget.path)\n".write(
      to: root.appendingPathComponent("linked/.git"), atomically: true, encoding: .utf8)
    try "gitdir: \(root.path)/removed/.git/worktrees/x\n".write(
      to: stale.appendingPathComponent(".git"), atomically: true, encoding: .utf8)
    #expect(isGitCheckout(real.path) && isGitCheckout(linked.path))
    #expect(!isGitCheckout(stale.path) && !isGitCheckout(plain.path) && !isGitCheckout(root.path + "/gone"))

    let paths = [stale.path, plain.path, root.path + "/gone", linked.path, real.path]
    let json = paths.map { #"{"path":"\#($0)","live":false,"warnings":[]}"# }.joined(separator: ",")
    let envs = try JSONDecoder().decode([Workspace].self, from: Data("[\(json)]".utf8))
    let project = { (path: String) in Project(root: path) }
    #expect(doctorCheckouts(envs, project: project).map(\.path) == [linked.path, real.path])
    #expect(doctorCheckout(for: stale.path, in: envs, project: project)?.path == linked.path)
  }
}
