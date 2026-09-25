import Foundation
import Testing

@testable import StimKit

@Suite struct StatusDecodingTests {
  let workspace: Workspace = {
    let url = Bundle.module.url(forResource: "status", withExtension: "json", subdirectory: "Fixtures")!
    let payload = try! JSONDecoder().decode(StatusPayload.self, from: Data(contentsOf: url))
    return payload.environments[0]
  }()

  @Test func listsDefaultDevicesBeforeSlotsAndRemoteSessionsLast() {
    #expect(workspace.devices.map(\.slot) == ["default", "default", "ipad", "default"])
    #expect(workspace.devices.map(\.isRunning) == [false, true, true, true])
  }

  @Test func decodesARemoteSessionWithItsPreviewURL() {
    guard case .remote(let remote) = workspace.devices.last else {
      Issue.record("expected a remote device last")
      return
    }
    #expect(remote.backend == "eas")
    #expect(remote.sessionId == "drs_9")
    #expect(remote.webPreviewUrl == "https://preview.example/9")
    #expect(workspace.devices.last?.id == "remote:drs_9")
  }

  @Test func decodesDeviceActivityAndIgnoresUnknownFields() {
    #expect(workspace.devices[2].activity?.driver?.tool == "agent-device")
    #expect(workspace.devices[1].activity?.state == "idle")
    #expect(workspace.devices[1].activityKey == "emulator-5554")
    #expect(workspace.devices[0].activity == nil)
  }

  @Test func decodesAMissingSimulatorWithoutAName() throws {
    let json = #"{"name":null,"udid":"1F11A62B","owned":true,"state":"missing"}"#
    let device = try JSONDecoder().decode(IosDevice.self, from: Data(json.utf8))
    #expect(device.name == "Missing simulator")
    #expect(device.state == "missing")
  }

  @Test func decodesAWorktreeGitSummary() throws {
    let url = Bundle.module.url(forResource: "status", withExtension: "json", subdirectory: "Fixtures")!
    let payload = try JSONDecoder().decode(StatusPayload.self, from: Data(contentsOf: url))
    let git = try #require(payload.unprovisionedWorktrees?.first?.git)
    #expect(git.uncommitted == 3)
    #expect(git.arrows == "\u{2191}3 \u{2193}1")
    #expect(git.summary == "3 uncommitted changes, 3 ahead of origin/feat/x, 1 behind")
    #expect(workspace.worktree?.git == nil)
  }

  @Test func showsNothingForACleanBranchAndFlagsAMergedOne() {
    #expect(!WorktreeGit(changed: 0, untracked: 0, upstream: "origin/x", ahead: 0, behind: 0).isNotable)
    #expect(!WorktreeGit(changed: 0, untracked: 0).isNotable)
    let merged = WorktreeGit(changed: 0, untracked: 0, upstream: "origin/x", mergedInto: "origin/main")
    #expect(merged.isNotable && merged.arrows == nil && merged.summary == "merged into origin/main")
  }

  @Test func keepsNestedParenthesesInTheModel() {
    #expect(workspace.devices[2].model == "iPad Pro 11-inch (M5) 27.0")
    #expect(workspace.devices[2].formFactor == .tablet)
  }
  @Test func estimatesTheRunningBuildFromComparableRuns() throws {
    let build = try #require(workspace.build)
    #expect(build.isRunning && build.phase == "compile" && build.basis == 4)
    let started = ISO8601DateFormatter().date(from: "2026-09-24T19:50:00Z")!
    let early = build.progress(at: started.addingTimeInterval(60))
    #expect(early.fraction == 0.25)
    #expect(early.remaining == "about 3 min left")
    #expect(build.progress(at: started.addingTimeInterval(200)).remaining == "under a minute left")
    let late = build.progress(at: started.addingTimeInterval(600))
    #expect(late.fraction == 0.99 && late.remaining == "longer than usual")
  }

  @Test func attachesTheBuildOnlyToTheDeviceItTargets() {
    #expect(workspace.devices.map { workspace.runningBuild(for: $0) != nil } == [true, false, false, false])
  }

  @Test func leavesABuildWithoutHistoryIndeterminate() throws {
    var build = try #require(workspace.build)
    build.expectedMs = nil
    let progress = build.progress(at: Date())
    #expect(progress.fraction == nil && progress.remaining == nil)
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

  @Test func abbreviatesOnlyPathsThatStartAtHome() {
    #expect(abbreviatingHome("/Users/jan", home: "/Users/jan") == "~")
    #expect(abbreviatingHome("/Users/jan/app/.worktrees/x", home: "/Users/jan") == "~/app/.worktrees/x")
    #expect(abbreviatingHome("/Users/janic/x", home: "/Users/jan") == "/Users/janic/x")
    #expect(abbreviatingHome("/private/Users/jan/x", home: "/Users/jan") == "/private/Users/jan/x")
    #expect(
      abbreviatingHome("kept: '/Users/jan/a' and /Users/janic/b, /Users/jan/c", home: "/Users/jan")
        == "kept: '~/a' and /Users/janic/b, ~/c")
  }

  @Test func namesTheFolderInsideItsCheckout() {
    #expect(pathInCheckout("/u/tlon/.worktrees/chat/apps/tlon-mobile", worktree: nil) == "apps/tlon-mobile")
    #expect(pathInCheckout("/u/stim/.claude/worktrees/1123/apps/mobile", worktree: nil) == "apps/mobile")
    #expect(pathInCheckout("/u/tlon/apps/tlon-mobile", worktree: "/u/tlon") == "apps/tlon-mobile")
    #expect(pathInCheckout("/u/tlon/.worktrees/chat", worktree: "/u/tlon/.worktrees/chat") == nil)
    #expect(pathInCheckout("/u/tlonx/app", worktree: "/u/tlon") == nil)
  }

  @Test func ordersDrivenThenRunningThenStoppedDevices() throws {
    let json = """
      {"path":"/w","live":true,"warnings":[],
       "ios":{"name":"stim-w (iPhone 18 Pro 27.0)","udid":"A","owned":true,"state":"Shutdown"},
       "android":{"name":"stim-w","owned":true,"physical":false,"state":"detected"},
       "slots":[{"slot":"duo","ios":{"name":"stim-w-duo (iPhone Duo 27.1)","udid":"B","owned":true,"state":"Booted",
         "activity":{"state":"driven","basis":[]}}}]}
      """
    let env = try JSONDecoder().decode(Workspace.self, from: Data(json.utf8))
    #expect(env.orderedDevices.map { "\($0.slot)/\($0.platform)" } == ["duo/ios", "default/android", "default/ios"])
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

  @Test func groupsWorktreesWithNoEnvironmentUnderTheirProject() throws {
    let json = #"""
      [{"path":"/r/app","live":false,"warnings":[]},{"path":"/r/zed/.worktrees/a","live":true,"warnings":[]}]
      """#
    let envs = try JSONDecoder().decode([Workspace].self, from: Data(json.utf8))
    let worktrees = [
      UnprovisionedWorktree(path: "/r/app/.worktrees/b", branch: "feat/b"),
      UnprovisionedWorktree(path: "/r/new/.worktrees/c", branch: nil),
    ]
    let summaries = projectSummaries(environments: envs, unprovisioned: worktrees, project: Project.init(fallbackFor:))
    #expect(
      summaries == [
        ProjectSummary(project: Project(root: "/r/zed"), live: 1, total: 1),
        ProjectSummary(project: Project(root: "/r/app"), live: 0, total: 2),
        ProjectSummary(project: Project(root: "/r/new"), live: 0, total: 1),
      ])
  }

  @Test func buildsAProjectTreeWithLiveWorkspacesFirstAndFilters() throws {
    let json = #"""
      [{"path":"/r/app/.worktrees/idle","live":false,"warnings":[]},
       {"path":"/r/app/.worktrees/live","live":true,"warnings":[]},
       {"path":"/r/zed","live":false,"warnings":[]}]
      """#
    let envs = try JSONDecoder().decode([Workspace].self, from: Data(json.utf8))
    let worktrees = [
      UnprovisionedWorktree(path: "/r/app/.worktrees/b", branch: "feat/b"),
      UnprovisionedWorktree(path: "/r/new/.worktrees/c", branch: nil),
    ]
    func tree(liveOnly: Bool = false, hidesUnprovisioned: Bool = false) -> [String] {
      projectTrees(
        environments: envs, unprovisioned: worktrees, project: Project.init(fallbackFor:), liveOnly: liveOnly,
        hidesUnprovisioned: hidesUnprovisioned
      ).map { node in
        "\(node.summary.project.name) \(node.summary.live)/\(node.summary.total): "
          + (node.environments.map(\.path) + node.worktrees.map(\.path)).joined(separator: ",")
      }
    }
    #expect(
      tree() == [
        "app 1/3: /r/app/.worktrees/live,/r/app/.worktrees/idle,/r/app/.worktrees/b",
        "new 0/1: /r/new/.worktrees/c", "zed 0/1: /r/zed",
      ])
    #expect(tree(liveOnly: true) == ["app 1/3: /r/app/.worktrees/live"])
    #expect(
      tree(hidesUnprovisioned: true) == [
        "app 1/3: /r/app/.worktrees/live,/r/app/.worktrees/idle", "zed 0/1: /r/zed",
      ])
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
        == StimCommand(["stop"], cwd: "/w"))
    #expect(
      remedyCommand(
        forWarning: "owned AVD stim-x is not detected by adb; rerun your `stim android` command", workspace: "/w")
        == StimCommand(["android"], cwd: "/w"))
    #expect(remedyCommand(forWarning: "something else", workspace: "/w") == nil)
  }

  @Test func quotesPathsForTheShell() {
    #expect(
      environmentCommands(worktree: "/Users/dev/it's here").map(\.shellLine) == [
        "cd '/Users/dev/it'\\''s here' && stim start",
        "cd '/Users/dev/it'\\''s here' && stim ios",
        "cd '/Users/dev/it'\\''s here' && stim android",
      ])
  }

  @Test func displaysHomePathsFromTildeAndStaysAShellLine() {
    #expect(
      StimCommand(["worktree", "remove", "/Users/jan/app/.worktrees/x"], cwd: "/Users/jan/it's here").displayLine(
        home: "/Users/jan") == "cd ~/'it'\\''s here' && stim worktree remove ~/app/.worktrees/x")
    #expect(StimCommand(["gc"], cwd: "/Users/jan").displayLine(home: "/Users/jan") == "cd ~ && stim gc")
    #expect(StimCommand(["gc"], cwd: "/Users/janic").displayLine(home: "/Users/jan") == "cd '/Users/janic' && stim gc")
  }

  @Test func stopsOneDeviceByItsSlot() {
    let ios = IosDevice(name: "stim-a (iPhone 17.0)", udid: "IOS-UDID", owned: true, state: "Booted")
    #expect(
      stopCommand(for: .ios(slot: "default", ios), cwd: "/w") == StimCommand(["stop", "--slot", "default"], cwd: "/w"))
    #expect(
      stopCommand(for: .ios(slot: "tablet", ios), cwd: "/w") == StimCommand(["stop", "--slot", "tablet"], cwd: "/w"))

    let android = AndroidDevice(name: "stim-b", owned: true, physical: false, serial: "emulator-5554", state: "detected")
    #expect(
      stopCommand(for: .android(slot: "phone", android), cwd: "/w")
        == StimCommand(["stop", "--slot", "phone"], cwd: "/w"))
  }

  @Test func stopsTheWholeWorkspaceForARemoteSession() {
    let remote = RemoteDevice(platform: "ios", backend: "eas", sessionId: "drs_9", state: "running")
    #expect(stopCommand(for: .remote(remote), cwd: "/w") == StimCommand(["stop"], cwd: "/w"))
  }
}

@Suite struct LineBufferTests {
  @Test func holdsASplitLineAndCharacterUntilTheNewline() {
    var buffer = LineBuffer()
    let bytes = Array("caf\u{00E9} ok\r\nnext".utf8)
    let cut = 4
    #expect(buffer.append(Data(bytes[..<cut])) == [])
    #expect(buffer.append(Data(bytes[cut...])) == ["caf\u{00E9} ok"])
    #expect(buffer.finish() == ["next"])
    #expect(buffer.finish() == [])
  }
}

@Suite struct ProcessStreamTests {
  private final class Collector: @unchecked Sendable {
    let lock = NSLock()
    var lines: [OutputLine] = []
    var linesAtExit: Int?
    var status: Int32?
  }

  private func run(_ script: String) async throws -> Collector {
    let collector = Collector()
    try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
      do {
        try ProcessStream.start(
          executable: "/bin/sh", arguments: ["-c", script], cwd: NSTemporaryDirectory(),
          onLine: { line in collector.lock.withLock { collector.lines.append(line) } },
          onExit: { status in
            collector.lock.withLock {
              collector.status = status
              collector.linesAtExit = collector.lines.count
            }
            done.resume()
          })
      } catch {
        done.resume(throwing: error)
      }
    }
    return collector
  }

  @Test func deliversEveryLineOfBothStreamsBeforeTheExitStatus() async throws {
    let result = try await run("i=0; while [ $i -lt 2000 ]; do echo out$i; i=$((i+1)); done; printf 'err tail' >&2; exit 3")
    #expect(result.status == 3)
    #expect(result.linesAtExit == 2001)
    #expect(result.lines.filter { $0.channel == .stdout }.last == OutputLine(.stdout, "out1999"))
    #expect(result.lines.filter { $0.channel == .stderr } == [OutputLine(.stderr, "err tail")])
  }

  @Test func reportsTheExitWhenABackgroundChildKeepsThePipeOpen() async throws {
    let started = Date()
    let result = try await run("sleep 30 & echo started")
    #expect(result.status == 0)
    #expect(result.lines == [OutputLine(.stdout, "started")])
    #expect(Date().timeIntervalSince(started) < 10)
  }
}

@Suite struct ActivityBadgeTests {
  let now = ISO8601DateFormatter().date(from: "2026-09-25T02:00:00Z")!

  func activity(_ state: String, last: String? = nil, since: String? = nil) -> DeviceActivity {
    DeviceActivity(
      state: state, driver: since.map { DeviceActivity.Driver(tool: "maestro", pid: 1, since: $0) },
      lastActivityAt: last, basis: [])
  }

  @Test func drivenNamesTheToolAndHowLong() {
    let badge = ActivityBadge(activity("driven", since: "2026-09-25T01:48:00.000Z"), now: now)
    #expect(badge?.text == "Driven by maestro \u{00B7} 12m")
  }

  @Test func idleCountsFromTheLatestActivity() {
    #expect(ActivityBadge(activity("idle", last: "2026-09-24T22:30:00.000Z"), now: now)?.text == "Idle 3h30m")
    #expect(ActivityBadge(activity("idle"), now: now)?.text == "Idle")
  }

  @Test func aRecentScreenChangeOverridesTheCLIsIdle() {
    let idle = activity("idle", last: "2026-09-24T20:00:00.000Z")
    #expect(ActivityBadge(idle, screenChangedAt: now.addingTimeInterval(-120), now: now) == nil)
    #expect(ActivityBadge(idle, screenChangedAt: now.addingTimeInterval(-3600), now: now)?.text == "Idle 1h")
  }

  @Test func activeShowsNothingAndUnknownNeverReadsAsIdle() {
    #expect(ActivityBadge(activity("active"), now: now) == nil)
    #expect(ActivityBadge(activity("unknown"), now: now) == .unknown)
  }
}

@Suite struct GcPreviewTests {
  @Test func idleAndUnrecognizedDevicesAreNeverCountedAsDeletable() throws {
    let json = """
      {"mode":"dry-run","idle":null,"actionable":false,"failures":null,"sections":{
        "idleDevices":[
          {"kind":"ios","id":"U1","name":"stim-a (iPhone 17 27.0)","project":"/p","slot":"default","lastActivityAt":null,"idleForMs":7200000,"buildInProgress":false},
          {"kind":"android","id":"stim-b","name":"stim-b","project":"/p","slot":"default","lastActivityAt":null,"idleForMs":90000000,"buildInProgress":true}],
        "unverifiedDevices":[{"kind":"ios","id":"U9","name":"stim-desktop-duo-test","command":"xcrun simctl delete U9"}]
      }}
      """
    let report = try GcPreview(json: Data(json.utf8))
    #expect(report.deletableCount == 0)
    #expect(report.sections.flatMap(\.entries).allSatisfy { $0.kept != nil })
    #expect(report.idleShutdownCount(atLeast: GcPreview.idleSeconds("1h")!) == 1)
    #expect(report.idleShutdownCount(atLeast: GcPreview.idleSeconds("4h")!) == 0)
  }


  @Test func marksWhatDeleteLeavesAlone() throws {
    let json = """
      {"mode":"dry-run","actionable":true,"failures":null,"sections":{
        "deadProjects":[],
        "orphanedWorkspaces":[{"dir":"/s/workspaces/a","projectRoot":"/p","bytes":4096}],
        "workspaceBuildOutputs":[
          {"dir":"/s/workspaces/b","bytes":1000,"willClear":false,"reason":"in-use","detail":"in use: supervisor running"},
          {"dir":"/s/workspaces/c","bytes":500,"willClear":true,"reason":null,"detail":null}],
        "buildsInProgress":[{"path":"/s/build-locks/x.lock","pid":1}],
        "caches":[{"name":"Metro transform cache","dir":"/s/metro","bytes":7,"willEmpty":false,"note":"no eviction"}],
        "futureSection":[{"id":"z"}]
      }}
      """
    let report = try GcPreview(json: Data(json.utf8))
    #expect(report.actionable)
    #expect(
      report.sections.map(\.key) == [
        "orphanedWorkspaces", "buildsInProgress", "workspaceBuildOutputs", "caches", "futureSection",
      ])
    let outputs = report.sections.first { $0.key == "workspaceBuildOutputs" }!.entries
    #expect(outputs.map(\.kept) == ["in use: supervisor running", nil])
    #expect(report.sections.first { $0.key == "buildsInProgress" }!.entries[0].kept != nil)
    #expect(report.sections.first { $0.key == "caches" }!.entries[0].kept == "no eviction")
    #expect(report.deletableCount == 3)
    #expect(report.reclaimableBytes == 4596)
  }

  @Test func surfacesTheRefusalContract() {
    let json = #"{"code":"STIM_BAD_ARG","message":"No shared cache carries \"x\".","remedy":"Pass --cache all."}"#
    #expect {
      try GcPreview(json: Data(json.utf8))
    } throws: { error in
      (error as? GcPreview.Failure)?.errorDescription == "No shared cache carries \"x\". Pass --cache all."
    }
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

@Suite struct LoginShellTests {
  @Test func parsesValuesWithEqualsSignsAndNewlines() {
    let output = Data("PATH=/a:/b\0OPTS=-Dx=1 -Dy=2\0MULTI=one\ntwo=2\n\0EMPTY=\0".utf8)
    #expect(
      LoginShell.parseEnvironment(output) == [
        "PATH": "/a:/b", "OPTS": "-Dx=1 -Dy=2", "MULTI": "one\ntwo=2\n", "EMPTY": "",
      ])
  }

  @Test func capturesTheLoginShellEnvironment() async throws {
    let environment = try #require(await LoginShell.environment())
    #expect(environment["HOME"] == NSHomeDirectory())
    #expect(environment["PATH"]?.contains("/usr/bin") == true)
  }

  @Test func resolvesStimFromThePathAndLetsStimBinWin() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let stim = dir.appendingPathComponent("stim").path
    FileManager.default.createFile(atPath: stim, contents: Data(), attributes: [.posixPermissions: 0o755])

    let found = StimCLI(environment: ["PATH": "/nonexistent:\(dir.path)", "ANDROID_HOME": "/sdk"])
    #expect(found.executable == stim)
    #expect(found.environment["ANDROID_HOME"] == "/sdk")

    let explicit = StimCLI(environment: ["PATH": dir.path, "STIM_BIN": "/opt/node/bin/stim"])
    #expect(explicit.executable == "/opt/node/bin/stim")
    #expect(explicit.environment["PATH"] == "/opt/node/bin:\(dir.path)")

    #expect(StimCLI(environment: ["PATH": "/nonexistent"]).executable == nil)

    let overridden = StimCLI(environment: ["PATH": dir.path, "STIM_BIN": "/opt/node/bin/stim"], override: "/custom/stim")
    #expect(overridden.executable == "/custom/stim")
    #expect(StimCLI(environment: ["PATH": dir.path], override: "").executable == stim)
  }

  @Test func returnsASettingsRefusalFromAFailedCommand() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let stim = dir.appendingPathComponent("stim").path
    let script = """
      #!/bin/sh
      echo "$*" > "\(dir.path)/args"
      echo '{"code":"STIM_BAD_ARG","message":"Invalid metro.tunnel value","remedy":"For example"}'
      exit 1
      """
    FileManager.default.createFile(atPath: stim, contents: Data(script.utf8), attributes: [.posixPermissions: 0o755])

    let result = try StimCLI(environment: ["PATH": "/usr/bin:/bin"], override: stim)
      .writeSetting("metro.tunnel", value: "wormhole", scope: .workspace, cwd: dir.path)

    guard case .refused(let refusal) = result else {
      Issue.record("expected a refusal")
      return
    }
    #expect(refusal.code == "STIM_BAD_ARG" && refusal.remedy == "For example")
    let args = try String(contentsOf: dir.appendingPathComponent("args"), encoding: .utf8)
    #expect(args == "settings set metro.tunnel wormhole --scope workspace --json\n")
  }
}

@Suite struct StatusWatchTests {
  @Test func fallsBackOnlyWhenStimRefusesTheWatchFlag() {
    #expect(StatusWatch.isUnsupported(stderr: ["error: unknown option '--watch'"]))
    #expect(!StatusWatch.isUnsupported(stderr: ["error: unknown option '--wtch'"]))
    #expect(!StatusWatch.isUnsupported(stderr: ["Error: EACCES: permission denied, open '/Users/dev/.stim/config.json'"]))
  }

  @Test func restartDelayDoublesToTheCapAndResetsAfterALongRun() {
    var backoff = RestartBackoff()
    #expect([0, 0, 0, 0, 0, 0, 0].map { backoff.delay(afterRunning: $0) } == [1, 2, 4, 8, 16, 30, 30])
    #expect(backoff.delay(afterRunning: 120) == 1)
    #expect(backoff.delay(afterRunning: 0) == 2)
  }
}
