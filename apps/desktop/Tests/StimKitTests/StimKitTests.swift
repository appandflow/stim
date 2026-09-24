import Foundation
import Testing

@testable import StimKit

@Suite struct StatusDecodingTests {
  let workspace: Workspace = {
    let url = Bundle.module.url(forResource: "status", withExtension: "json", subdirectory: "Fixtures")!
    let payload = try! JSONDecoder().decode(StatusPayload.self, from: Data(contentsOf: url))
    return payload.environments[0]
  }()

  @Test func listsDefaultDevicesBeforeSlots() {
    #expect(workspace.devices.map(\.slot) == ["default", "default", "ipad"])
    #expect(workspace.devices.map(\.isRunning) == [false, true, true])
  }

  @Test func keepsNestedParenthesesInTheModel() {
    #expect(workspace.devices[2].model == "iPad Pro 11-inch (M5) 27.0")
    #expect(workspace.devices[2].formFactor == .tablet)
  }
}

@Suite struct NamingTests {
  @Test func titlesAPackageInsideAWorktree() {
    let names = PathNames(path: "/Users/dev/app/.worktrees/wide-insets/apps/mobile")
    #expect(names.title == "wide-insets")
    #expect(names.subtitle == "mobile")
  }

  @Test func subtitlesAWorktreeRootWithItsRepository() {
    let names = PathNames(path: "/Users/dev/app/.worktrees/sdk58")
    #expect(names.title == "sdk58")
    #expect(names.subtitle == "app")
  }

  @Test func projectFromGitCommonDir() {
    #expect(Project(gitCommonDir: "/Users/dev/app/.git").root == "/Users/dev/app")
    #expect(Project(gitCommonDir: "/srv/app.git").root == "/srv/app.git")
    #expect(Project(fallbackFor: "/Users/dev/app/.worktrees/x/apps/mobile").root == "/Users/dev/app")
  }

  @Test func groupsAWorktreeOutsideTheRepositoryWithItsRepository() throws {
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("stimkit-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: tmp) }
    let repo = tmp.appendingPathComponent("app").path
    let outside = tmp.appendingPathComponent("elsewhere/wt").path
    try git(["init", "-q", repo])
    try git(["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"])
    try git(["-C", repo, "worktree", "add", "-q", outside])
    try FileManager.default.createDirectory(atPath: outside + "/apps/mobile", withIntermediateDirectories: true)

    let expected = (repo as NSString).resolvingSymlinksInPath
    #expect(Project.resolve(workspace: outside + "/apps/mobile").root == expected)
    #expect(Project.resolve(workspace: repo).root == expected)
  }

  private func git(_ args: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = args
    try process.run()
    process.waitUntilExit()
    #expect(process.terminationStatus == 0)
  }
}

@Suite struct RemedyTests {
  @Test func mapsStatusWarningsToCommands() {
    #expect(
      remedyCommand(forWarning: "stale supervisor record for /w", workspace: "/w")
        == "cd '/w' && stim stop")
    #expect(
      remedyCommand(
        forWarning: "owned AVD stim-x is not detected by adb; rerun your `stim android` command", workspace: "/w")
        == "cd '/w' && stim android")
    #expect(remedyCommand(forWarning: "something else", workspace: "/w") == nil)
  }

  @Test func quotesPathsForTheShell() {
    #expect(warmCommand(worktree: "/Users/dev/it's here") == "cd '/Users/dev/it'\\''s here' && stim worktree warm")
  }
}
