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

@Suite struct ResourceTests {
  let ps = """
      1     0  20176 14:27.71 /sbin/launchd
    500     1  10240   0:01.00 stim-supervisor
    501   500  20480 229:34.42 node metro
    502   501   1024   0:00.50 node worker
    600     1   2048   0:00.10 launchd_sim /Users/dev/Library/Developer/CoreSimulator/Devices/7466D06C-1AE4-4EDB-8A93-6B8A43A7A47A/data/var/run/launchd_bootstrap.plist
    601   600   4096 1-02:03:04.50 SpringBoard
    700     1   8192   0:02.00 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd stim-app -port 5604
    701     1   8192   0:02.00 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd stim-app-duo -port 5606
    800     1   1024   0:00.00 launchd_sim /Users/dev/Library/Developer/CoreSimulator/Devices/00000000-0000-0000-0000-000000000000/data/var/run/launchd_bootstrap.plist
  """

  func workspace(supervisor: Int? = 500, metro: Int? = 501, live: Bool = true) throws -> Workspace {
    let json = """
      {"path":"/w","live":\(live),"warnings":[],
       "supervisor":{"pid":\(supervisor.map(String.init) ?? "null")},
       "metro":{"port":8081,"running":true,"pid":\(metro.map(String.init) ?? "null")},
       "ios":{"name":"stim-app (iPhone 18 Pro 27.0)","udid":"7466d06c-1ae4-4edb-8a93-6b8a43a7a47a","owned":true,"state":"Booted"},
       "android":{"name":"stim-app","owned":true,"physical":false,"serial":"emulator-5604","state":"detected"}}
      """
    return try JSONDecoder().decode(Workspace.self, from: Data(json.utf8))
  }

  @Test func parsesPsIncludingLongCpuTimes() {
    let rows = ProcessTable.parse(ps)
    #expect(rows.count == 9)
    #expect(rows[2] == ProcessEntry(pid: 501, ppid: 500, residentBytes: 20480 * 1024, cpuSeconds: 13774.42, args: "node metro"))
    let expected: Double = 86_400 + 7_384.5
    #expect(rows[5].cpuSeconds == expected)
  }

  @Test func findsSimulatorAndEmulatorByIdentityNotPrefix() throws {
    let roots = workspaceRoots(try workspace(), in: ProcessTable.parse(ps))
    #expect(roots == [500, 501, 600, 700])
  }

  @Test func ignoresASupervisorPidOfAWorkspaceThatIsNotLive() throws {
    let roots = workspaceRoots(try workspace(metro: nil, live: false), in: ProcessTable.parse(ps))
    #expect(!roots.contains(500))
  }

  @Test func countsEachProcessOnceWhenRootsNest() throws {
    var sampler = ResourceSampler()
    let processes = ProcessTable.parse(ps)
    let usage = sampler.sample([try workspace()], processes: processes, at: Date(timeIntervalSince1970: 0))["/w"]
    #expect(usage?.processCount == 6)
    let resident: Int64 = 46_080 * 1024
    #expect(usage?.residentBytes == resident)
    #expect(usage?.cpuPercent == nil)
  }

  @Test func cpuIsTheChangeInCpuTimeOverTheInterval() throws {
    var sampler = ResourceSampler()
    let env = try workspace(supervisor: nil, metro: 700)
    let first = [ProcessEntry(pid: 700, ppid: 1, residentBytes: 0, cpuSeconds: 10, args: "")]
    _ = sampler.sample([env], processes: first, at: Date(timeIntervalSince1970: 0))
    let second = [
      ProcessEntry(pid: 700, ppid: 1, residentBytes: 0, cpuSeconds: 13, args: ""),
      ProcessEntry(pid: 701, ppid: 700, residentBytes: 0, cpuSeconds: 1.5, args: ""),
    ]
    let usage = sampler.sample([env], processes: second, at: Date(timeIntervalSince1970: 3))["/w"]
    #expect(usage?.cpuPercent == 150)
  }

  @Test func sumsOnlyWhatGcDeleteWouldFree() throws {
    let json = """
      {"mode":"dry-run","sections":{
        "orphanedWorkspaces":[{"dir":"/a","projectRoot":"/p","bytes":4096}],
        "orphanedDevices":[{"kind":"ios","id":"X","name":"n","bytes":null,"directory":null}],
        "parkedSimulators":[{"udid":"Y","bytes":1000}],
        "workspaceBuildOutputs":[{"dir":"/b","bytes":9000000000,"willClear":false},{"dir":"/c","bytes":500,"willClear":true}],
        "caches":[{"name":"c","dir":"/d","bytes":7000,"willEmpty":false}],
        "staleBuildLocks":[{"path":"/l"}]}}
      """
    let reclaimable = try JSONDecoder().decode(GcReport.self, from: Data(json.utf8)).reclaimable
    #expect(reclaimable == GcReport.Reclaimable(bytes: 4096 + 1000 + 500, entries: 4, unsized: 1))
  }

  @Test func mergesLocationsOnTheSameVolume() {
    let volumes = DiskUsage.merge([
      DiskVolume(id: "/", name: "Macintosh HD", availableBytes: 1, totalBytes: 2, holds: ["Repositories"]),
      DiskVolume(id: "/Volumes/X", name: "X", availableBytes: 3, totalBytes: 4, holds: ["Simulators"]),
      DiskVolume(id: "/", name: "Macintosh HD", availableBytes: 1, totalBytes: 2, holds: ["Stim home"]),
    ])
    #expect(volumes.map(\.holds) == [["Repositories", "Stim home"], ["Simulators"]])
  }
}

@Suite struct OpenURLTests {
  @Test func readsTheUdidOnlyFromAnOpenURL() {
    #expect(simulatorUdid(fromOpenURL: URL(string: "stim-desktop://open?udid=U1")!) == "U1")
    #expect(simulatorUdid(fromOpenURL: URL(string: "stim-desktop://close?udid=U1")!) == nil)
    #expect(simulatorUdid(fromOpenURL: URL(string: "siniulator://open?udid=U1")!) == nil)
    #expect(simulatorUdid(fromOpenURL: URL(string: "stim-desktop://open?udid=")!) == nil)
  }

  @Test func findsTheWorkspaceThatOwnsASlotSimulator() throws {
    let url = Bundle.module.url(forResource: "status", withExtension: "json", subdirectory: "Fixtures")!
    let payload = try JSONDecoder().decode(StatusPayload.self, from: Data(contentsOf: url))
    let owner = try #require(payload.owner(ofSimulator: "D39CAF14-F4A4-4C0A-B8A4-3A30B2D268F0"))
    #expect(owner.workspace.path == "/Users/dev/app/.worktrees/wide-insets/apps/mobile")
    #expect(owner.device.slot == "ipad")
    #expect(payload.owner(ofSimulator: "emulator-5554") == nil)
  }
}
