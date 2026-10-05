import Foundation
import Testing

@testable import StimKit

@Suite struct BuildCacheTests {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
  }

  @Test func runListKeepsOrderAndIdentityAcrossCompletionWithoutDuplicatingTheActiveSlot() throws {
    let workspace = try decode(
      Workspace.self,
      """
      {"path":"/w","live":true,"warnings":[],"build":{
        "platform":"ios","slot":"default","state":"running","phase":"compile",
        "startedAt":"2026-09-25T12:00:00Z","phaseStartedAt":"2026-09-25T12:00:01Z","basis":0},
       "builds":{"ios":[
        {"platform":"ios","status":"ok","cacheHit":false,"startedAt":"2026-09-25T12:00:00Z",
         "result":"succeeded","slot":"default","phases":{"compile":1000}},
        {"platform":"ios","status":"ok","cacheHit":"local","startedAt":"2026-09-25T12:00:00Z",
         "result":"succeeded","slot":"fold","phases":{}},
        {"platform":"ios","status":"ok","cacheHit":"remote","startedAt":"2026-09-25T11:00:00Z",
         "result":"succeeded","slot":"default","phases":{}}]}}
      """)
    let history = try #require(workspace.builds?.ios)
    let active = BuildRun.runs(platform: "ios", running: workspace.build, history: history, last: nil)
    #expect(active.map(\.slot) == ["default", "fold", "default"])
    #expect(active.map(\.startedAt) == ["2026-09-25T12:00:00Z", "2026-09-25T12:00:00Z", "2026-09-25T11:00:00Z"])
    #expect(active.first?.running == workspace.build)
    #expect(Set(active.map(\.id)).count == 3)
    let finished = BuildRun.runs(platform: "ios", running: nil, history: history, last: history[0].build)
    #expect(active.map(\.id) == finished.map(\.id))
    #expect(finished.first?.history == history[0])
    #expect(BuildRun.runs(platform: "android", running: workspace.build, history: [], last: nil).isEmpty)
  }

  @Test func runListUsesLastBuildOnlyWithoutHistoryAndDoesNotRepeatAnActiveRun() throws {
    let last = try decode(
      LastBuild.self,
      #"{"platform":"ios","status":"ok","cacheHit":"local","startedAt":"2026-09-25T12:00:00Z"}"#)
    let fallback = BuildRun.runs(platform: "ios", running: nil, history: [], last: last)
    #expect(fallback.count == 1 && fallback.first?.last == last)
    #expect(fallback.first?.slot == "default")
    let running = try decode(
      Build.self,
      #"{"platform":"ios","slot":"default","state":"running","phase":"compile","startedAt":"2026-09-25T12:00:00Z","phaseStartedAt":"2026-09-25T12:00:01Z","basis":0}"#
    )
    #expect(BuildRun.runs(platform: "ios", running: running, history: [], last: last).count == 1)
    var older = last
    older.startedAt = "2026-09-25T11:00:00Z"
    #expect(
      BuildRun.runs(platform: "ios", running: running, history: [], last: older).map(\.startedAt) == [
        running.startedAt, older.startedAt,
      ])
    #expect(BuildRun.runs(platform: "ios", running: nil, history: [], last: nil).isEmpty)
  }

  @Test func finishedStepsUseBuildOrderAndActualTimesAndIdentifyWhereAnInterruptedRunStopped() throws {
    var entry = try decode(
      BuildHistoryEntry.self,
      #"{"platform":"ios","status":"ok","cacheHit":false,"startedAt":"2026-09-25T12:00:00Z","result":"succeeded","slot":"default","phases":{"launch":100,"compile":9000,"prepare":200,"pods":0,"unknown":42}}"#
    )
    #expect(
      entry.finishedSteps == [
        PhaseStep(phase: "prepare", state: .done, elapsedMs: 200, expectedMs: nil, fraction: 1),
        PhaseStep(phase: "pods", state: .done, elapsedMs: 0, expectedMs: nil, fraction: 1),
        PhaseStep(phase: "compile", state: .done, elapsedMs: 9000, expectedMs: nil, fraction: 1),
        PhaseStep(phase: "launch", state: .done, elapsedMs: 100, expectedMs: nil, fraction: 1),
      ])
    #expect(entry.stoppedPhase == nil)
    entry.result = "interrupted"
    #expect(entry.stoppedPhase == "pods")
    entry.phases["pods"] = 500
    #expect(entry.stoppedPhase == "launch")
    entry.phases = [:]
    #expect(entry.finishedSteps.isEmpty && entry.stoppedPhase == nil)
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
    #expect(ios.cacheHit == .none && ios.status == "ok" && ios.durationMs == 83123)
    let android = try #require(workspace.lastBuilds?.build(for: "android"))
    #expect(android.status == "failed" && android.errorCode == "STIM_BUILD_FAILED" && android.cacheHit == .remote)
  }

  @Test func readsTheBuildHistoryOfEachPlatformWithHowEachRunEnded() throws {
    let workspace = try decode(
      Workspace.self,
      """
      {"path":"/w","live":true,"warnings":[],"builds":{
        "ios":[
          {"platform":"ios","status":"failed","cacheHit":false,"cacheSkipped":false,"durationMs":99918,
           "fingerprint":null,"startedAt":"2026-09-26T12:58:00.000Z","finishedAt":"2026-09-26T12:59:39.918Z",
           "errorCode":"STIM_CANCELLED","result":"cancelled","slot":"default","configuration":"Debug","cacheKey":null,
           "phases":{"pods":90794,"prepare":2260}},
          {"platform":"ios","status":"ok","cacheHit":"local","cacheSkipped":false,"durationMs":18128,
           "fingerprint":"7a512dbf","startedAt":"2026-09-26T12:50:00.000Z","finishedAt":"2026-09-26T12:50:18.128Z",
           "result":"succeeded","slot":"default","configuration":"Debug","cacheKey":"7a512dbf-debug-sim","phases":{}}],
        "android":[
          {"platform":"android","status":"failed","cacheHit":false,"cacheSkipped":false,"durationMs":null,
           "fingerprint":null,"startedAt":"2026-09-26T13:00:20.861Z","finishedAt":null,"result":"interrupted",
           "slot":"tablet","configuration":null,"cacheKey":null,"phases":{"prepare":1524,"device":3000,"compile":0}}]}}
      """)
    let ios = try #require(workspace.builds?.builds(for: "ios"))
    #expect(ios.map(\.result) == ["cancelled", "succeeded"])
    #expect(ios[0].phases == ["pods": 90794, "prepare": 2260])
    #expect(ios[1].build.cacheHit == .local && ios[1].slot == "default" && ios[1].phases.isEmpty)
    let android = try #require(workspace.builds?.builds(for: "android").first)
    #expect(android.result == "interrupted" && android.slot == "tablet" && android.configuration == nil)
    #expect(android.phases == ["prepare": 1524, "device": 3000, "compile": 0])
    let failed = try decode(
      BuildHistoryEntry.self,
      """
      {"platform":"android","status":"failed","cacheHit":false,"durationMs":27583,"startedAt":"2026-09-26T12:57:50.000Z",
       "finishedAt":null,"errorCode":"STIM_BUILD_FAILED","result":"failed","slot":"default","phases":{},
       "missReason":{"kind":"changed","summary":"android/ added (+2 more)","changes":[],"changeCount":3,
         "baseline":null,"rekeyedBy":[]}}
      """)
    #expect(failed.result == "failed" && failed.build.errorCode == "STIM_BUILD_FAILED")
    #expect(failed.build.missReason?.summary == "android/ added (+2 more)")
    #expect(try decode(Workspace.self, #"{"path":"/w","live":false,"warnings":[]}"#).builds == nil)
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
    #expect(reason.baseline?.fingerprint == "0123456789abcdef" && reason.baseline?.from == "project")
  }

  @Test func describesAPlannedHitMissAndRefusal() throws {
    let hit = try decode(
      BuildPlan.self,
      """
      {"platform":"ios","fingerprint":"1b62","cacheKey":"k","cacheHit":"remote","provider":"eas","cacheSkipped":false,
       "prebuild":null,"outcome":"hit","expectedMs":2656,"basis":1}
      """)
    #expect(hit.cacheHit == .remote && hit.outcome == "hit" && hit.expectedMs == 2656)

    let miss = try decode(
      BuildPlan.self,
      """
      {"platform":"android","fingerprint":"f","cacheKey":"k","cacheHit":false,"provider":null,"cacheSkipped":false,
       "prebuild":"regenerate","outcome":"cold","expectedMs":null,"basis":0,
       "missReason":{"kind":"prebuild-pending","summary":"native dependency added: expo-clipboard (before prebuild regenerates android/)",
         "changes":[{"source":"node_modules/expo-clipboard/android","change":"added","category":"native-dependency"}],
         "changeCount":1,"baseline":{"fingerprint":"0123456789abcdef","from":"workspace"},"rekeyedBy":[]}}
      """)
    #expect(miss.outcome == "cold" && miss.prebuild == "regenerate")
    #expect(miss.missReason?.baseline?.from == "workspace")

    let refused = try decode(
      BuildPlan.self,
      """
      {"platform":"ios","fingerprint":"f","cacheKey":null,"cacheHit":false,"provider":"eas","cacheSkipped":false,
       "prebuild":null,"outcome":null,"expectedMs":null,"basis":0,
       "refusal":{"code":"STIM_EAS_BUILD_MISSING","message":"No compatible EAS ios build.","remedy":"Run eas build."}}
      """)
    #expect(refused.refusal?.code == "STIM_EAS_BUILD_MISSING" && refused.outcome == nil)
  }

  @Test func hidesHistoricalOutcomesUntilTheRunKnowsItsCacheResult() throws {
    var build = try decode(
      Build.self,
      """
      {"platform":"ios","slot":"default","state":"running","phase":"cache-lookup","startedAt":"2026-09-25T12:00:00Z",
       "phaseStartedAt":"2026-09-25T12:00:01Z","outcome":"cold","expectedMs":null,"expectedPhaseMs":null,"basis":0}
      """)
    #expect(build.outcomeLabel == nil && build.cacheLookupOutcome == nil)
    build.phase = "compile"
    #expect(build.outcomeLabel == "Cold build")
    build.outcome = "hit"
    build.phase = "install"
    #expect(build.outcomeLabel == "Cache hit")
    build.outcome = nil
    #expect(build.outcomeLabel == nil)
    build.outcome = "hit"
    build.phase = "device"
    build.outcomeKnown = false
    #expect(build.outcomeLabel == nil)
    build.outcomeKnown = true
    #expect(build.outcomeLabel == "Cache hit" && build.cacheLookupOutcome == nil)
  }

  @Test func showsAMissBeforePodsAsACacheMissAndNotesTheRecheck() throws {
    let build = try decode(
      Build.self,
      """
      {"platform":"ios","slot":"default","state":"running","phase":"pods","startedAt":"2026-09-25T12:00:00Z",
       "phaseStartedAt":"2026-09-25T12:00:01Z","outcome":"cold","outcomeKnown":true,"cacheLookupOutcome":"miss","expectedMs":null,
       "expectedPhaseMs":null,"basis":0,"missProvisional":true,
       "missReason":{"kind":"changed","summary":"native dependency added: expo-clipboard","changes":[],
                     "changeCount":1,"baseline":null,"rekeyedBy":[]}}
      """)
    #expect(build.outcomeLabel == "Cache miss" && build.cacheLookupOutcome == "miss")
    #expect(build.recheckNote != nil)
    var compiling = build
    compiling.phase = "compile"
    compiling.missProvisional = nil
    #expect(compiling.outcomeLabel == "Cache miss")
    #expect(compiling.recheckNote == nil)
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

    #expect(
      result == .refused(CommandRefusal(code: "STIM_NO_DEVICE", message: "No system image is installed.", remedy: "Install one."))
    )
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
    let pid = try #require(
      Int32(String(contentsOfFile: pidFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)))
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
