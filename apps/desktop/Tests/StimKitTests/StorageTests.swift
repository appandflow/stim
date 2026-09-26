import Foundation
import Testing

@testable import StimKit

@Suite struct StorageReportTests {
  let paths = StoragePaths(home: "/Users/me")
  let owned = "11111111-1111-1111-1111-111111111111"
  let parked = "22222222-2222-2222-2222-222222222222"
  let users = "33333333-3333-3333-3333-333333333333"

  func workspace() throws -> Workspace {
    let json = """
      {"path":"/r/.worktrees/a/app","live":true,"warnings":[],
       "worktree":{"path":"/r/.worktrees/a","branch":"feat-a","repository":"/r"},
       "ios":{"name":"stim-a","udid":"\(owned.lowercased())","owned":true,"state":"Booted"},
       "android":{"name":"Pixel","owned":false,"physical":false,"state":"device"},
       "slots":[{"slot":"tablet","android":{"name":"stim-a-tablet","owned":true,"physical":false,"state":"device"}}]}
      """
    return try JSONDecoder().decode(Workspace.self, from: Data(json.utf8))
  }

  func gc() throws -> GcReport {
    let json = """
      {"sections":{
        "linkedWorktrees":[{"path":"/r/.worktrees/a","idleDays":2,"mergedInto":"origin/main","willRemove":true}],
        "parkedSimulators":[{"udid":"\(parked)","name":"stim-parked","bytes":3072}],
        "workspaceBuildOutputs":[{"dir":"/h/w/a","projectRoot":"/r/.worktrees/a/app","bytes":8192,"willClear":false,
          "detail":"in use: dev server running"}],
        "caches":[{"name":"Gradle build cache","dir":"/Users/me/.gradle/caches/build-cache-1","bytes":2048}]}}
      """
    return try JSONDecoder().decode(GcReport.self, from: Data(json.utf8))
  }

  /// Catches double counting: a Stim cache inside an unmanaged location, or a Stim simulator counted as the user's.
  @Test func attributesSpaceToTheWorkspaceAndKeepsStimOutOfUnmanagedTotals() throws {
    let du = """
      4\t/r/.worktrees/a/node_modules
      10\t/Users/me/Library/Developer/CoreSimulator/Devices/\(owned)
      3\t/Users/me/Library/Developer/CoreSimulator/Devices/\(parked)
      7\t/Users/me/Library/Developer/CoreSimulator/Devices/\(users)
      20\t/Users/me/Library/Developer/CoreSimulator/Devices
      5\t/Users/me/.android/avd/stim-a-tablet.avd
      9\t/Users/me/.android/avd/Pixel.avd
      14\t/Users/me/.android/avd
      6\t/Users/me/.gradle/caches
      du: /Users/me/Library/Caches/locked: Permission denied
      1\t/Users/me/Library/Caches
      """
    let report = StorageReport.make(
      environments: [try workspace()], gc: try gc(), disk: DiskMeasurements(sizes: DiskSizes.parse(du)), paths: paths)

    let row = try #require(report.workspaces.first)
    #expect(row.buildOutputs == .size(8192))
    #expect(row.buildOutputsKept == "in use: dev server running")
    #expect(row.nodeModules == .size(4096))
    #expect(row.devices == .size((10 + 5) * 1024))
    #expect(row.deviceCount == 2)
    #expect(row.worktree?.mergedInto == "origin/main")

    #expect(report.reclaimableDevices?.size == .size(3072))
    let unmanaged: [String: Int64] = Dictionary(
      report.unmanaged.compactMap { location in location.size.bytes.map { (location.title, $0) } },
      uniquingKeysWith: { a, _ in a })
    #expect(unmanaged["Simulators Stim does not own"] == Int64(7 * 1024))
    #expect(unmanaged["Gradle caches"] == Int64(6 * 1024 - 2048))
    #expect(unmanaged["~/Library/Caches"] == Int64(1024))
    #expect(unmanaged["Xcode DerivedData"] == nil)
  }

  /// Catches a slow or timed-out tree blanking every row, and an absent gc entry reading as unknown.
  @Test func givesEveryCategoryASizeOrAReason() throws {
    let modules = "/r/.worktrees/a/node_modules"
    let measuring = DiskMeasurements(
      sizes: ["\(paths.simulatorDevices)/\(owned)": 10_240, paths.simulatorDevices: 20_480],
      pending: [modules, paths.avds])
    var row = try #require(
      StorageReport.make(environments: [try workspace()], gc: nil, disk: measuring, paths: paths).workspaces.first)
    #expect(row.buildOutputs == .notMeasured && row.nodeModules == .measuring && row.devices == .measuring)
    #expect(row.total == nil)

    let gcLoaded = try JSONDecoder().decode(GcReport.self, from: Data(#"{"sections":{}}"#.utf8))
    let bare = try JSONDecoder().decode(Workspace.self, from: Data(#"{"path":"/p","live":false,"warnings":[]}"#.utf8))
    let unsized = try #require(
      StorageReport.make(
        environments: [bare], gc: gcLoaded, disk: DiskMeasurements(failed: ["/p/node_modules"]), paths: paths
      ).workspaces.first)
    #expect(unsized.total == nil)

    let noOutputs = try JSONDecoder().decode(GcReport.self, from: Data(#"{"sections":{}}"#.utf8))
    let finished = DiskMeasurements(
      sizes: ["\(paths.simulatorDevices)/\(owned)": 10_240, paths.simulatorDevices: 20_480, paths.avds: 0],
      failed: [modules])
    row = try #require(
      StorageReport.make(environments: [try workspace()], gc: noOutputs, disk: finished, paths: paths).workspaces.first)
    #expect(row.buildOutputs == .absent && row.nodeModules == .failed && row.devices == .size(10_240))
    #expect(row.total == 10_240 && !row.totalComplete)
  }

  @Test func ranksRowsBySizeWithUnsizedRowsLast() throws {
    func env(_ path: String) throws -> Workspace {
      try JSONDecoder().decode(Workspace.self, from: Data(#"{"path":"\#(path)","live":false,"warnings":[]}"#.utf8))
    }
    let disk = DiskMeasurements(
      sizes: ["/small/node_modules": 1, "/big/node_modules": 9, "/w/new/node_modules": 5], pending: ["/unknown/node_modules"])
    let fresh = UnprovisionedWorktree(path: "/w/new", branch: "new", repository: "/w/repo", git: nil)
    let report = StorageReport.make(
      environments: [try env("/unknown"), try env("/small"), try env("/big")], unprovisioned: [fresh], gc: nil,
      disk: disk, paths: paths)
    #expect(report.workspaces.map(\.path) == ["/big", "/w/new", "/small", "/unknown"])
    #expect(report.workspaces[1].unprovisioned && report.workspaces[1].repositoryName == "repo")
  }

  /// Catches per-project Metro stores reading as identical rows whose Empty button can never select one.
  @Test func namesSameNamedCachesByDirectoryAndSortsThemBySize() throws {
    let json = """
      {"sections":{"deadProjects":[{"path":"/gone"}],"caches":[
        {"name":"Metro transform cache","dir":"/s/metro-cache/app","bytes":0},
        {"name":"Build cache","dir":"/s/build-cache","bytes":4096},
        {"name":"Metro transform cache","dir":"/s/metro-cache/tlon-mobile","bytes":8192}]}}
      """
    let gc = try JSONDecoder().decode(GcReport.self, from: Data(json.utf8))
    let gone = try JSONDecoder().decode(Workspace.self, from: Data(#"{"path":"/gone","live":false,"warnings":[]}"#.utf8))
    let report = StorageReport.make(environments: [gone], gc: gc, disk: DiskMeasurements(), paths: paths)
    #expect(report.caches.map { $0.title(among: report.allCaches) } == ["Metro transform cache: tlon-mobile", "Build cache"])
    #expect(report.emptyCaches.map(\.dir) == ["/s/metro-cache/app"])
    #expect(report.caches.first?.selector(among: report.allCaches) == "/s/metro-cache/tlon-mobile")
    #expect(report.workspaces.first?.missing == true)
  }
}

@Suite struct WorktreeLifecycleTests {
  func worktree(idle: Int?, merged: String? = nil) -> GcReport.LinkedWorktree {
    GcReport.LinkedWorktree(path: "/w", idleDays: idle, mergedInto: merged, willRemove: merged != nil, detail: nil)
  }

  let pulls = ["feat": PullRequest(number: 42, url: "https://github.com/o/r/pull/42", headRefName: "feat")]

  @Test func mergedWinsOverAnOpenPullRequest() {
    #expect(
      WorktreeLifecycle(worktree: worktree(idle: 1, merged: "origin/main"), branch: "feat", pulls: pulls)
        == .merged(into: "origin/main"))
  }

  @Test func anOpenPullRequestKeepsAnIdleWorktreeFromReadingAsStale() {
    #expect(
      WorktreeLifecycle(worktree: worktree(idle: 30), branch: "feat", pulls: pulls)
        == .pullRequest(number: 42, url: "https://github.com/o/r/pull/42"))
  }

  @Test func withoutTheGitHubCLIIdlenessAloneDecides() {
    #expect(WorktreeLifecycle(worktree: worktree(idle: 7), branch: "feat", pulls: nil) == .stale(days: 7))
    #expect(WorktreeLifecycle(worktree: worktree(idle: 6), branch: "feat", pulls: nil) == .active)
    #expect(WorktreeLifecycle(worktree: worktree(idle: nil), branch: "feat", pulls: nil) == .active)
    #expect(WorktreeLifecycle(worktree: nil, branch: "main", pulls: nil) == nil)
  }

  @Test func readsGhPullRequestsByBranchAndRejectsAnythingElse() {
    let json = #"[{"number":7,"url":"https://github.com/o/r/pull/7","headRefName":"fix"}]"#
    #expect(PullRequest.byBranch(Data(json.utf8))?["fix"]?.number == 7)
    #expect(PullRequest.byBranch(Data("no git remotes found".utf8)) == nil)
  }
}

@Suite struct AutopilotTests {
  let calendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Montreal")!
    return calendar
  }()

  func date(_ day: Int, _ hour: Int, _ minute: Int = 0) -> Date {
    calendar.date(from: DateComponents(year: 2026, month: 9, day: day, hour: hour, minute: minute))!
  }

  @Test func runsNightlyOnceAfterTheHourAndCatchesUpAMissedNight() {
    #expect(!AutopilotSchedule.nightlyDue(now: date(25, 2, 59), hour: 3, lastRun: date(24, 3, 1), calendar: calendar))
    #expect(AutopilotSchedule.nightlyDue(now: date(25, 3), hour: 3, lastRun: date(24, 3, 1), calendar: calendar))
    #expect(!AutopilotSchedule.nightlyDue(now: date(25, 14), hour: 3, lastRun: date(25, 3, 1), calendar: calendar))
    #expect(AutopilotSchedule.nightlyDue(now: date(25, 1), hour: 3, lastRun: date(23, 3, 1), calendar: calendar))
  }

  @Test func boundsTheNightlyCleanupByAgeAndLeavesPressureRunsUnbounded() {
    #expect(AutopilotSchedule.nightlyArguments(olderThanDays: 7) == ["gc", "--delete", "--worktrees", "--older-than", "7"])
    #expect(AutopilotSchedule.nightlyArguments(olderThanDays: 14).suffix(2) == ["--older-than", "14"])
    #expect(PressurePlan.arguments == ["gc", "--delete"])
  }

  func device(idleSince: Date, screen: Date? = nil) -> AutopilotSchedule.Device {
    let stamp = ISO8601DateFormatter().string(from: idleSince)
    return AutopilotSchedule.Device(
      activity: DeviceActivity(state: "idle", driver: nil, lastActivityAt: stamp, basis: []), screenChangedAt: screen)
  }

  @Test func shutsDownIdleDevicesOnlyWhenNoWatchedScreenWouldGoWithThem() {
    let now = date(25, 12)
    let idle = device(idleSince: now.addingTimeInterval(-7200))
    let watched = device(idleSince: now.addingTimeInterval(-7200), screen: now.addingTimeInterval(-60))
    let recent = device(idleSince: now.addingTimeInterval(-600))
    #expect(AutopilotSchedule.idleShutdownDue([idle, recent], minutes: 60, now: now))
    #expect(!AutopilotSchedule.idleShutdownDue([idle, watched], minutes: 60, now: now))
    #expect(!AutopilotSchedule.idleShutdownDue([recent], minutes: 60, now: now))
  }

  @Test func proposesGcDeleteOnlyUnderTheBudget() throws {
    let gib: Int64 = 1_073_741_824
    let json = """
      {"sections":{
        "linkedWorktrees":[{"path":"/w","mergedInto":"origin/main","willRemove":true},{"path":"/x","willRemove":false}],
        "parkedSimulators":[{"udid":"U","bytes":1000000000}],
        "workspaceBuildOutputs":[{"projectRoot":"/a","bytes":25000000000,"willClear":true},
          {"projectRoot":"/b","bytes":9,"willClear":true},{"projectRoot":"/c","bytes":5,"willClear":false}]}}
      """
    let report = try JSONDecoder().decode(GcReport.self, from: Data(json.utf8))
    #expect(PressurePlan.make(freeBytes: 25 * gib, minimumFreeGb: 20, hardFloorGb: 5, report: report) == nil)
    #expect(PressurePlan.make(freeBytes: gib, minimumFreeGb: 0, hardFloorGb: 0, report: report) == nil)

    let plan = try #require(PressurePlan.make(freeBytes: 12 * gib, minimumFreeGb: 20, hardFloorGb: 5, report: report))
    #expect(!plan.belowHardFloor)
    #expect(plan.headline == "Disk 12.0 GB free, under the 20 GB Stim budget")
    #expect(
      plan.proposal
        == "Clear the build outputs of 2 idle workspaces, remove 1 merged worktree and delete 1 unused owned device to free about 26 GB."
    )

    let bare = try #require(PressurePlan.make(freeBytes: 4 * gib, minimumFreeGb: 20, hardFloorGb: 5, report: nil))
    #expect(bare.isEmpty && bare.belowHardFloor)
  }

  @Test func keepsTheNewestLogEntriesFirst() {
    var log: [AutopilotLogEntry] = []
    for index in 0..<(AutopilotLog.limit + 5) {
      log = AutopilotLog.appending(
        AutopilotLogEntry(date: Date(), trigger: .idle, command: "\(index)", exitStatus: 0, note: nil), to: log)
    }
    #expect(log.count == AutopilotLog.limit)
    #expect(log.first?.command == "\(AutopilotLog.limit + 4)")
    #expect(AutopilotLog.decode(AutopilotLog.encode(log)) == log)
  }
}

@Suite struct GcDeleteScopeTests {
  @Test func selectsACacheAloneByNameElseByDirectory() {
    let gradle = GcReport.Cache(name: "Gradle build cache", dir: "/g", bytes: nil, note: nil, willEmpty: nil)
    let build = GcReport.Cache(name: "Build cache", dir: "/b", bytes: nil, note: nil, willEmpty: nil)
    let cas = GcReport.Cache(name: "Xcode CAS", dir: "/x", bytes: nil, note: nil, willEmpty: nil)
    let example = GcReport.Cache(name: "Metro", dir: "/m/example", bytes: nil, note: nil, willEmpty: nil)
    let examples = GcReport.Cache(name: "Metro", dir: "/m/example-2", bytes: nil, note: nil, willEmpty: nil)
    let all = [gradle, build, cas, example, examples]
    #expect(gradle.selector(among: all) == "Gradle build cache")
    #expect(build.selector(among: all) == "/b")
    #expect(cas.selector(among: all) == "Xcode CAS")
    #expect(examples.selector(among: all) == "/m/example-2")
    #expect(example.selector(among: all) == nil)
  }

  @Test func aScopedPreviewDeletesOnlyThatScope() {
    #expect(GcPreview.deleteArguments(after: ["gc", "--json"]) == ["gc", "--delete"])
    #expect(
      GcPreview.deleteArguments(after: ["gc", "--json", "--cache", "Xcode CAS"]) == ["gc", "--cache", "Xcode CAS", "--delete"])
    #expect(GcPreview.deleteArguments(after: ["gc", "--idle", "1h"]) == nil)
    #expect(GcPreview.deleteArguments(after: ["gc", "--delete"]) == nil)
  }
}

@Suite struct BudgetSettingTests {
  @Test func readsABudgetSetByAnEnvironmentVariable() throws {
    let json = """
      {"files":{},"unknown":[],"settings":[
        {"key":"budget.minFreeDiskGb","value":"40","origin":"env","layers":{}},
        {"key":"budget.hardFloorDiskGb","value":5,"origin":"default","layers":{}}]}
      """
    let payload = try JSONDecoder().decode(SettingsPayload.self, from: Data(json.utf8))
    #expect(payload.entry("budget.minFreeDiskGb")?.number == 40)
    #expect(payload.entry("budget.hardFloorDiskGb")?.number == 5)
  }
}
