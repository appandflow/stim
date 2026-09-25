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
    #expect(hit.summary == "Remote cache hit (eas)")
    #expect(hit.expectation == "~0m 2s, median of 1 hit run")

    let miss = try decode(
      BuildPlan.self,
      """
      {"platform":"android","fingerprint":"f","cacheKey":"k","cacheHit":false,"provider":null,"cacheSkipped":false,
       "prebuild":"regenerate","outcome":"cold","expectedMs":null,"basis":0}
      """)
    #expect(miss.summary == "Cache miss: compiles, regenerates the native dir")
    #expect(miss.expectation == "No cold run of this project recorded yet")

    let refused = try decode(
      BuildPlan.self,
      """
      {"platform":"ios","fingerprint":"f","cacheKey":null,"cacheHit":false,"provider":"eas","cacheSkipped":false,
       "prebuild":null,"outcome":null,"expectedMs":null,"basis":0,
       "refusal":{"code":"STIM_EAS_BUILD_MISSING","message":"No compatible EAS ios build.","remedy":"Run eas build."}}
      """)
    #expect(refused.summary == "Would refuse: STIM_EAS_BUILD_MISSING")
    #expect(refused.expectation == nil)
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

  @Test func returnsTheCLIRefusalWhenAPlanCannotBeComputed() throws {
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

    let result = try StimCLI(environment: ["PATH": "/usr/bin:/bin"], override: stim)
      .plan(platform: "android", workspace: dir.path)

    #expect(result == .refused(CommandRefusal(code: "STIM_NO_DEVICE", message: "No system image is installed.", remedy: "Install one.")))
    let args = try String(contentsOf: dir.appendingPathComponent("args"), encoding: .utf8)
    #expect(args == "android --plan --json\n")
  }
}
