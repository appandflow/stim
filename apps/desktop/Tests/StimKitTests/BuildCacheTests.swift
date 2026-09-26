import Foundation
import Testing

@testable import StimKit

@Suite struct BuildCacheTests {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
  }

  @Test func readsEachPlatformsLastBuildIncludingACompiledOneWhoseCacheHitIsFalse() throws {
    let workspace = try decode(
      Workspace.self,
      """
      {"path":"/w","live":true,"warnings":[],"lastBuilds":{
        "ios":{"platform":"ios","status":"ok","cacheHit":false,"cacheSkipped":false,"durationMs":83123,
               "fingerprint":"1b62","startedAt":"2026-09-25T12:28:58.294Z","finishedAt":"2026-09-25T12:30:21.417Z"},
        "android":{"platform":"android","status":"failed","cacheHit":"remote","durationMs":4000,
                   "startedAt":"2026-09-25T12:00:00.000Z","finishedAt":null,"errorCode":"STIM_BUILD_FAILED"}}}
      """)
    let ios = try #require(workspace.lastBuilds?.build(for: "ios"))
    #expect(ios.cacheHit == .none && ios.summary == "Cache miss, compiled in 1m 23s")
    #expect(workspace.lastBuilds?.build(for: "android")?.summary == "Failed (STIM_BUILD_FAILED) in 0m 4s")
  }

  @Test func readsAMissReasonAndNamesItsBaseline() throws {
    let last = try decode(
      LastBuild.self,
      """
      {"platform":"ios","status":"ok","cacheHit":false,"cacheSkipped":false,"durationMs":1000,
       "startedAt":"2026-09-25T12:00:00.000Z","finishedAt":"2026-09-25T12:00:01.000Z",
       "missReason":{"kind":"changed","summary":"native dependency added: expo-clipboard",
         "changes":[{"source":"node_modules/expo-clipboard","change":"added","category":"native-dependency"}],
         "changeCount":3,"baseline":{"fingerprint":"0123456789abcdef","from":"project"},"rekeyedBy":[]}}
      """)
    let reason = try #require(last.missReason)
    #expect(reason.changes.first?.category == "native-dependency" && reason.changeCount == 3)
    #expect(reason.baselineLine == "Compared with 01234567, the last build of this project in another worktree.")
  }

  @Test func describesAPlannedHitMissAndRefusal() throws {
    let hit = try decode(
      BuildPlan.self,
      """
      {"platform":"ios","fingerprint":"1b62","cacheKey":"k","cacheHit":"remote","provider":"eas","cacheSkipped":false,
       "prebuild":null,"outcome":"hit","expectedMs":2656,"basis":1}
      """)
    #expect(hit.nextBuild == "cache hit (remote), ~0m 2s")
    #expect(hit.detail == "From eas. Median of 1 hit run")

    let miss = try decode(
      BuildPlan.self,
      """
      {"platform":"android","fingerprint":"f","cacheKey":"k","cacheHit":false,"provider":null,"cacheSkipped":false,
       "prebuild":"regenerate","outcome":"cold","expectedMs":null,"basis":0,
       "missReason":{"kind":"prebuild-pending","summary":"native inputs match the last build (before prebuild regenerates android/)",
         "changes":[],"changeCount":0,"baseline":{"fingerprint":"0123456789abcdef","from":"workspace"},"rekeyedBy":[]}}
      """)
    #expect(miss.missReason?.baselineLine == "Compared with 01234567, the last build in this workspace.")
    #expect(miss.nextBuild == "cold build, regenerates the native dir")
    #expect(miss.detail == "No cold run of this project recorded yet")

    let refused = try decode(
      BuildPlan.self,
      """
      {"platform":"ios","fingerprint":"f","cacheKey":null,"cacheHit":false,"provider":"eas","cacheSkipped":false,
       "prebuild":null,"outcome":null,"expectedMs":null,"basis":0,
       "refusal":{"code":"STIM_EAS_BUILD_MISSING","message":"No compatible EAS ios build.","remedy":"Run eas build."}}
      """)
    #expect(refused.nextBuild == "would refuse (STIM_EAS_BUILD_MISSING)")
    #expect(refused.detail == nil)
  }

  @Test func marksTheRunningOutcomeLikelyUntilTheRunReachesACacheDecidingPhase() throws {
    var build = try decode(
      Build.self,
      """
      {"platform":"ios","slot":"default","state":"running","phase":"cache-lookup","startedAt":"2026-09-25T12:00:00Z",
       "phaseStartedAt":"2026-09-25T12:00:01Z","outcome":"cold","expectedMs":null,"expectedPhaseMs":null,"basis":0}
      """)
    #expect(build.outcomeLabel == "Likely cold")
    build.phase = "compile"
    #expect(build.outcomeLabel == "Cold build")
    build.outcome = "hit"
    build.phase = "install"
    #expect(build.outcomeLabel == "Cache hit")
    build.outcome = nil
    #expect(build.outcomeLabel == nil)
  }

  @Test func returnsTheCLIRefusalWhenAPlanCannotBeComputed() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let stim = dir.appendingPathComponent("stim").path
    let script = """
      #!/bin/sh
      echo "$*" > "\(dir.path)/args"
      echo '{"code":"STIM_NO_DEVICE","message":"No system image is installed.","remedy":"Install one."}'
      exit 1
      """
    FileManager.default.createFile(atPath: stim, contents: Data(script.utf8), attributes: [.posixPermissions: 0o755])

    let result = try await StimCLI(environment: ["PATH": "/usr/bin:/bin"], override: stim)
      .plan(platform: "android", workspace: dir.path)

    #expect(result == .refused(CommandRefusal(code: "STIM_NO_DEVICE", message: "No system image is installed.", remedy: "Install one.")))
    let args = try String(contentsOf: dir.appendingPathComponent("args"), encoding: .utf8)
    #expect(args == "android --plan --json\n")
  }

  @Test func terminatesThePlanProcessWhenTheCheckIsCancelled() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let stim = dir.appendingPathComponent("stim").path
    let pidFile = dir.appendingPathComponent("pid").path
    let script = """
      #!/bin/sh
      echo $$ > "\(pidFile)"
      exec sleep 30
      """
    FileManager.default.createFile(atPath: stim, contents: Data(script.utf8), attributes: [.posixPermissions: 0o755])
    let cli = StimCLI(environment: ["PATH": "/usr/bin:/bin"], override: stim)

    let task = Task { try await cli.plan(platform: "ios", workspace: dir.path) }
    while !FileManager.default.fileExists(atPath: pidFile) { try await Task.sleep(for: .milliseconds(20)) }
    let pid = try #require(Int32(String(contentsOfFile: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)))
    task.cancel()

    await #expect(throws: CancellationError.self) { try await task.value }
    #expect(kill(pid, 0) != 0)
  }
}

@MainActor
@Suite struct BuildPlanChecksTests {
  private final class Planner: @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [String] = []
    private var active = 0
    private(set) var mostActive = 0
    var delay: Duration = .milliseconds(20)

    var recorded: [String] { lock.withLock { calls } }

    func plan(_ platform: String, _ workspace: String) async throws -> BuildPlanOutcome {
      lock.withLock {
        calls.append("\(workspace) \(platform)")
        active += 1
        mostActive = max(mostActive, active)
      }
      defer { lock.withLock { active -= 1 } }
      try await Task.sleep(for: delay)
      return .refused(CommandRefusal(code: "STIM_TEST", message: platform, remedy: nil))
    }
  }

  private func settled(_ checks: BuildPlanChecks, _ workspace: String, _ platforms: [String]) async throws {
    for _ in 0..<200 {
      if platforms.allSatisfy({ checks.entry(workspace: workspace, platform: $0)?.state != .checking }) { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    Issue.record("checks did not settle")
  }

  @Test func runsOnePlanPerBuildAndReusesAFreshResult() async throws {
    let planner = Planner()
    var now = Date(timeIntervalSince1970: 0)
    let checks = BuildPlanChecks(planner: planner.plan, now: { now })

    checks.check(workspace: "/w", builds: ["ios": "a", "android": "b"])
    checks.check(workspace: "/w", builds: ["ios": "a", "android": "b"])
    try await settled(checks, "/w", ["ios", "android"])
    #expect(planner.recorded == ["/w android", "/w ios"])
    #expect(planner.mostActive == 1)

    now += 59
    checks.check(workspace: "/w", builds: ["ios": "a", "android": "b"])
    #expect(planner.recorded.count == 2)

    checks.check(workspace: "/w", builds: ["ios": "a2", "android": "b"])
    try await settled(checks, "/w", ["ios"])
    #expect(planner.recorded == ["/w android", "/w ios", "/w ios"])

    now += 61
    checks.check(workspace: "/w", builds: ["android": "b"])
    checks.check(workspace: "/w", builds: ["ios": "a2"], force: true)
    try await settled(checks, "/w", ["ios", "android"])
    #expect(planner.recorded.count == 5)
    #expect(planner.mostActive == 1)
  }

  @Test func cancellingForgetsUnfinishedChecksAndLetsTheNextOneRun() async throws {
    let planner = Planner()
    let checks = BuildPlanChecks(planner: planner.plan)
    checks.check(workspace: "/w", builds: ["android": "b"])
    try await settled(checks, "/w", ["android"])

    planner.delay = .seconds(30)
    checks.check(workspace: "/w", builds: ["ios": "a", "android": "b2"])
    checks.cancel(workspace: "/w")
    #expect(checks.entry(workspace: "/w", platform: "ios") == nil)
    #expect(checks.entry(workspace: "/w", platform: "android") == nil)

    planner.delay = .milliseconds(20)
    checks.check(workspace: "/w", builds: ["ios": "a"])
    try await settled(checks, "/w", ["ios"])
    guard case .done = checks.entry(workspace: "/w", platform: "ios")?.state else {
      Issue.record("the check after cancelling did not finish")
      return
    }
    #expect(planner.mostActive == 1)
  }
}
