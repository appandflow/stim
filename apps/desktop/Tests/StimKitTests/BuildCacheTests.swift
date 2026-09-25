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
    #expect(ios.cacheHit == .none && ios.summary == "Compiled in 1m 23s")
    #expect(workspace.lastBuilds?.build(for: "android")?.summary == "Failed (STIM_BUILD_FAILED) in 0m 4s")
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
}
