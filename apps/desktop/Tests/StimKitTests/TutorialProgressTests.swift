import Foundation
import Testing

@testable import StimKit

private let tourPath = "/Users/example/stim-tutorial-tour"
private let tourStart = parseTimestamp("2026-10-07T04:56:00.000Z")!
private let afterBuild = parseTimestamp("2026-10-07T05:02:00.000Z")!
private let afterRebuild = parseTimestamp("2026-10-07T05:06:00.000Z")!
private let stepIDs = [
  "begin", "sidebar", "build", "rebuild", "device", "logs", "agent", "refresh", "phone", "machine", "finish",
]

private func fixture(_ name: String) throws -> StatusPayload {
  let url = Bundle.module.url(forResource: "tutorial-status-" + name, withExtension: "json", subdirectory: "Fixtures")!
  return try JSONDecoder().decode(StatusPayload.self, from: Data(contentsOf: url))
}

private func environment(_ name: String = "03-after-rebuild") throws -> TutorialEnvironment {
  try TutorialEnvironment(fixture(name).environments[0])!
}

private func saved(at step: String, since: Date = tourStart) -> TutorialRecord {
  var record = TutorialRecord(
    version: 1, tourPath: tourPath, startedAt: tourStart, step: step,
    done: Array(stepIDs.prefix(while: { $0 != step })))
  record.stepSince = since
  return record
}

private func state(_ id: String, in snapshot: TutorialSnapshot) -> TutorialStepProgress {
  snapshot.steps.first { $0.id == id }!
}

private func log(
  _ message: String, at date: Date, source: String = "device", level: String = "info",
  event: String? = nil, device: String? = nil, command: String? = nil
) throws -> LogRecord {
  var fields: [String: Any] = ["ts": date.timeIntervalSince1970 * 1000, "src": source, "level": level, "msg": message]
  fields["event"] = event
  fields["deviceId"] = device
  fields["command"] = command
  return try JSONDecoder().decode(LogRecord.self, from: JSONSerialization.data(withJSONObject: fields))
}

@Test func tutorialArchiveDecisionRequiresExactTourPathAndRemovalAfterRunStart() throws {
  let record = TutorialRecord(version: 1, tourPath: tourPath, startedAt: afterRebuild)
  var entry = try #require(fixture("06-archived").archived?.first)
  entry.removedAt = "2026-10-07T05:06:00.000Z"
  #expect(record.archivedProjectRoots(in: [entry]).isEmpty)
  entry.removedAt = "2026-10-07T05:05:00.000Z"
  #expect(record.archivedProjectRoots(in: [entry]).isEmpty)
  entry.removedAt = "2026-10-07T05:07:00.000Z"
  #expect(record.archivedProjectRoots(in: [entry]) == [tourPath])
  entry.projectRoot = tourPath + "-other"
  entry.replacedBy = tourPath
  #expect(record.archivedProjectRoots(in: [entry]).isEmpty)
}

@Test func tutorialBeginCheckpointDoesNotOfferRestartBeforeRunPromptCopy() throws {
  let legacy = try JSONDecoder().decode(
    TutorialRecord.self,
    from: Data(
      #"{"version":1,"startedAt":0,"step":"begin","done":[],"skipped":[],"manual":false}"#.utf8))
  var progress = TutorialProgress()
  let waiting = progress.update(TutorialInput(environment: nil, now: afterBuild, record: legacy))
  #expect(!state("begin", in: waiting).detail.hasPrefix("No tutorial workspace"))
  progress.copiedRunPrompt(now: afterBuild)
  let beforeTimeout = progress.update(TutorialInput(environment: nil, now: afterBuild.addingTimeInterval(179)))
  #expect(!state("begin", in: beforeTimeout).detail.hasPrefix("No tutorial workspace"))
  let timedOut = progress.update(TutorialInput(environment: nil, now: afterBuild.addingTimeInterval(180)))
  #expect(state("begin", in: timedOut).detail.hasPrefix("No tutorial workspace"))
}

@Test func tutorialFirstRunWaitsForBuildAndReportsColdPhases() throws {
  var progress = TutorialProgress()
  let started = try environment("01-started")
  #expect(progress.update(TutorialInput(environment: started, now: tourStart)).currentStep == "sidebar")
  #expect(progress.update(TutorialInput(environment: started, now: tourStart.addingTimeInterval(5))).currentStep == "sidebar")
  let result = progress.update(TutorialInput(environment: try environment("02-after-ios1"), now: afterBuild))
  #expect(result.currentStep == "rebuild")
  #expect(state("build", in: result).state == .done)
  #expect(state("build", in: result).detail.contains("no earlier build"))
  #expect(state("build", in: result).ticks.contains { $0.id == "pods" && $0.done })
  #expect(!state("rebuild", in: result).canMarkDone)
}

@Test func tutorialSidebarRemainsVisibleForThreeSecondsEvenWhenBuildFinishes() throws {
  var progress = TutorialProgress()
  var env = try environment("02-after-ios1")
  env.phaseSince = tourStart
  _ = progress.update(TutorialInput(environment: env, now: tourStart))
  #expect(progress.update(TutorialInput(environment: env, now: tourStart.addingTimeInterval(2))).currentStep == "sidebar")
  #expect(progress.update(TutorialInput(environment: env, now: afterBuild)).currentStep == "rebuild")
}

@Test func tutorialRepeatRunAcceptsAFirstBuildCacheHit() throws {
  var progress = TutorialProgress()
  var env = try environment()
  env.builds = Array(env.builds.prefix(1))
  let result = progress.update(TutorialInput(environment: env, now: afterRebuild, record: saved(at: "build")))
  #expect(state("build", in: result).state == .done)
  #expect(state("build", in: result).detail.contains("Local cache"))
  #expect(result.currentStep == "rebuild")
}

@Test func tutorialRebuildMissStillAdvancesAndExplainsWhy() throws {
  var progress = TutorialProgress()
  var env = try environment("02-after-ios1")
  env.builds[0].build.startedAt = "2026-10-07T05:04:00.000Z"
  env.builds[0].build.finishedAt = "2026-10-07T05:05:00.000Z"
  env.lastBuild = env.builds[0].build
  let result = progress.update(
    TutorialInput(environment: env, now: afterRebuild, record: saved(at: "rebuild", since: afterBuild)))
  #expect(result.currentStep == "device")
  #expect(state("rebuild", in: result).state == .done)
  #expect(state("rebuild", in: result).detail.contains("no earlier build"))
}

@Test func tutorialFailedBuildReportsDecodedCauseAndDiagnosticAndCanRecover() throws {
  let data = Data(
    """
    {"path":"/Users/example/stim-tutorial-tour","live":true,"warnings":[],"tutorial":{"version":1},
    "lastBuilds":{"ios":{"platform":"ios","status":"failed","cacheHit":false,
    "startedAt":"2026-10-07T04:57:09.561Z","cause":{"key":"App.swift:12","file":"App.swift","line":12},
    "diagnostics":[{"message":"Unknown symbol"}]}}}
    """.utf8)
  let workspace = try JSONDecoder().decode(Workspace.self, from: data)
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(environment: TutorialEnvironment(workspace), now: afterBuild, record: saved(at: "build")))
  #expect(state("build", in: result).state == .failed("App.swift:12: Unknown symbol"))
  #expect(result.currentStep == "build")
  let recovered = progress.update(TutorialInput(environment: try environment("02-after-ios1"), now: afterBuild))
  #expect(recovered.currentStep == "rebuild")
}

@Test func tutorialRelaunchReevaluatesBuildsCompletedWhileClosed() throws {
  let suite = "TutorialProgressTests-" + UUID().uuidString
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let store = TutorialRecordStore(defaults)
  var record = saved(at: "build")
  record.step = "rebuild"
  record.manual = true
  store.record = record
  let relaunchedStore = TutorialRecordStore(defaults)
  var progress = TutorialProgress()
  let result = progress.update(TutorialInput(environment: try environment(), now: afterRebuild, record: relaunchedStore.record))
  #expect(result.currentStep == "device")
  #expect(state("build", in: result).state == .done)
  #expect(state("rebuild", in: result).state == .done)
  #expect(result.shouldReopen)
  #expect(result.record.manual)
}

@Test func tutorialTracksSavedPathOtherwiseNewestPhase() throws {
  var first = try fixture("01-started").environments[0]
  first.phaseSince = "2026-10-07T04:56:00.000Z"
  var second = first
  second.path = "/Users/example/second-tour"
  second.phaseSince = "2026-10-07T05:06:00.000Z"
  #expect(TutorialEnvironment.select([first, second], trackedPath: tourPath)?.path == tourPath)
  #expect(TutorialEnvironment.select([first, second], trackedPath: nil)?.path == second.path)
  #expect(TutorialEnvironment.select([first, second], trackedPath: "/missing")?.path == second.path)
}

@Test func tutorialUnsupportedVersionsFailBeforeAcceptingSignals() throws {
  for (version, message) in [
    (2, "Update Stim Desktop to follow this tutorial"), (0, "Restart the tutorial with the current Stim CLI"),
  ] {
    var env = try environment()
    env.version = version
    var progress = TutorialProgress()
    let result = progress.update(TutorialInput(environment: env, now: afterRebuild, record: saved(at: "rebuild")))
    #expect(result.currentStep == "rebuild")
    #expect(state("rebuild", in: result).state == .failed(message))
  }
}

@Test func tutorialDeviceRequiresMatchingViewerOpenThenInputAndRunningApp() throws {
  var env = try environment("04-live-clean")
  var progress = TutorialProgress()
  var input = TutorialInput(
    environment: env, viewerEvents: [.opened("other"), .input("other"), .input("tutorial-simulator")],
    now: afterRebuild, record: saved(at: "device"))
  #expect(progress.update(input).currentStep == "device")
  input.viewerEvents = [.opened("tutorial-simulator")]
  #expect(progress.update(input).currentStep == "device")
  input.viewerEvents = [.input("tutorial-simulator")]
  #expect(progress.update(input).currentStep == "logs")
  env = try environment("05-stopped")
  var stopped = TutorialProgress()
  let result = stopped.update(TutorialInput(environment: env, now: afterRebuild, record: saved(at: "device")))
  #expect(state("device", in: result).state == .failed("Ask your agent to run the app again"))
}

@Test func tutorialLogsMatchRealCrashAndSlowMessagesRegardlessOfLevel() throws {
  var progress = TutorialProgress()
  let logs = try [
    log("[stim:tutorial] error-button test error", at: afterRebuild, level: "error"),
    log("[Error: [stim:tutorial] crash-button uncaught test error]", at: afterRebuild, source: "metro", level: "error"),
    log("[stim:tutorial] slow-request 3004ms", at: afterRebuild, level: "info"),
  ]
  let result = progress.update(
    TutorialInput(environment: try environment(), logRecords: logs, now: afterRebuild, record: saved(at: "logs")))
  #expect(result.currentStep == "agent")
  #expect(state("logs", in: result).ticks.allSatisfy { $0.done })
}

@Test func tutorialRefreshNeedsADifferentColorAfterStepEntry() throws {
  var progress = TutorialProgress()
  let old = try log("[stim:tutorial] title color=#1f2937", at: afterBuild)
  let earlyEdit = try log("[stim:tutorial] title color=#7c3aed", at: afterRebuild.addingTimeInterval(-1))
  var input = TutorialInput(
    environment: try environment(), logRecords: [old, earlyEdit], now: afterRebuild,
    record: saved(at: "refresh", since: afterRebuild))
  #expect(progress.update(input).currentStep == "refresh")
  input.logRecords = [try log("[stim:tutorial] title color=#1f2937", at: afterRebuild)]
  #expect(progress.update(input).currentStep == "refresh")
  input.logRecords = [try log("[stim:tutorial] title color=#7c3aed", at: afterRebuild.addingTimeInterval(6))]
  #expect(progress.update(input).currentStep == "phone")
}

@Test func tutorialRefreshChangedColorRecoversFromErrorAfterRelaunchWithOnlyNewLogs() throws {
  var env = try environment()
  env.errorsSinceMarker = 2
  var progress = TutorialProgress()
  let initial = progress.update(
    TutorialInput(
      environment: env, logRecords: [try log("title color=#1f2937", at: afterBuild)],
      now: afterRebuild, record: saved(at: "refresh", since: afterRebuild)))
  env.errorsSinceMarker = 3
  let failed = progress.update(TutorialInput(environment: env, now: afterRebuild))
  #expect(state("refresh", in: failed).state == .failed("The edit introduced an error"))
  var relaunched = TutorialProgress()
  let persisted = try JSONDecoder().decode(TutorialRecord.self, from: JSONEncoder().encode(initial.record))
  let result = relaunched.update(
    TutorialInput(
      environment: env, logRecords: [try log("title color=#7c3aed", at: afterRebuild)],
      now: afterRebuild, record: persisted))
  #expect(state("refresh", in: result).state == .done)
  #expect(result.currentStep == "phone")
}

@Test func tutorialRefreshRetakesErrorBaselineForRemainingTourAgentActions() throws {
  var env = try environment()
  env.errorsSinceMarker = 1
  var progress = TutorialProgress()
  var input = TutorialInput(
    environment: env,
    logRecords: try [
      log("title color=#1f2937", at: afterBuild),
      log("open", at: afterRebuild, source: "agent", event: "agent_action", device: "tutorial-simulator"),
    ], now: afterRebuild, record: saved(at: "agent", since: afterRebuild))
  #expect(progress.update(input).currentStep == "refresh")
  for (offset, errors) in [(1.0, 2), (2.0, 3)] {
    env.errorsSinceMarker = errors
    input.environment = env
    input.now = afterRebuild.addingTimeInterval(offset)
    input.logRecords.append(try log("press", at: input.now, source: "agent", event: "agent_action", device: "tutorial-simulator"))
    let result = progress.update(input)
    #expect(state("refresh", in: result).state == .current)
    #expect(result.record.refreshErrors == errors)
  }
  env.errorsSinceMarker = 4
  input.environment = env
  let failed = progress.update(input)
  #expect(state("refresh", in: failed).state == .failed("The edit introduced an error"))
  var relaunched = TutorialProgress()
  input.record = try JSONDecoder().decode(TutorialRecord.self, from: JSONEncoder().encode(failed.record))
  #expect(state("refresh", in: relaunched.update(input)).state == .failed("The edit introduced an error"))
  input.logRecords.append(try log("title color=#7c3aed", at: afterRebuild.addingTimeInterval(60)))
  input.now = afterRebuild.addingTimeInterval(60)
  #expect(progress.update(input).currentStep == "phone")
}

@Test func tutorialAgentRequiresFreshActionOnTourDeviceAndReplayEvidence() throws {
  var progress = TutorialProgress()
  let actionDate = afterRebuild.addingTimeInterval(1)
  let early = try log("press", at: afterBuild, source: "agent", event: "agent_action", device: "tutorial-simulator")
  let wrong = try log("press", at: actionDate, source: "agent", event: "agent_action", device: "other")
  let failed = try log("replay", at: actionDate, source: "agent", event: "agent_failed", device: "tutorial-simulator")
  var input = TutorialInput(
    environment: try environment(), logRecords: [early, wrong, failed], now: actionDate,
    record: saved(at: "agent", since: afterRebuild))
  #expect(progress.update(input).currentStep == "agent")
  let first = try log(
    "open", at: actionDate, source: "agent", event: "agent_action", device: "tutorial-simulator", command: "open")
  let error = try log("[stim:tutorial] error-button test error", at: actionDate.addingTimeInterval(1), level: "error")
  input.logRecords = [first, error]
  let result = progress.update(input)
  #expect(result.currentStep == "refresh")
  #expect(state("agent", in: result).ticks.first { $0.id == "agent-replay" }?.done == false)
  input.logRecords += try [
    log("[stim:tutorial] error-button test error", at: actionDate.addingTimeInterval(3), level: "error"),
    log(
      "close", at: actionDate.addingTimeInterval(4), source: "agent", event: "agent_action", device: "tutorial-simulator",
      command: "close"),
  ]
  #expect(state("agent", in: progress.update(input)).ticks.first { $0.id == "agent-replay" }?.done == true)
  input.replayOff = true
  #expect(!state("agent", in: progress.update(input)).ticks.contains { $0.id == "screen-recording" })
}

@Test func tutorialFinishCompletesWithArchiveWithoutIntermediateStopSnapshot() throws {
  var progress = TutorialProgress()
  _ = progress.update(TutorialInput(environment: try environment(), now: afterRebuild, record: saved(at: "finish")))
  let archives = try fixture("06-archived").archived!.map(\.projectRoot)
  let result = progress.update(TutorialInput(environment: nil, archivedProjectRoots: archives, now: afterRebuild))
  #expect(result.isComplete)
  #expect(state("finish", in: result).ticks.first { $0.id == "stopped" }?.done == false)
  #expect(state("finish", in: result).ticks.first { $0.id == "archived" }?.done == true)
}

@Test func tutorialFinishStopTickAloneDoesNotComplete() throws {
  var progress = TutorialProgress()
  let archives = try fixture("06-archived").archived!.map(\.projectRoot)
  var env = try environment("05-stopped")
  env.live = false
  let result = progress.update(
    TutorialInput(
      environment: env, archivedProjectRoots: archives,
      now: afterRebuild, record: saved(at: "finish")))
  #expect(result.currentStep == "finish")
  #expect(state("finish", in: result).ticks.first { $0.id == "stopped" }?.done == true)
}

@Test func tutorialArchiveDisabledCompletesOnDisappearanceAndMissingArchiveOffersRestart() throws {
  var progress = TutorialProgress()
  _ = progress.update(TutorialInput(environment: try environment(), now: afterRebuild, record: saved(at: "finish")))
  let missing = progress.update(TutorialInput(environment: nil, now: afterRebuild))
  #expect(missing.currentStep == "finish")
  #expect(state("finish", in: missing).detail.contains("Restart"))
  let result = progress.update(TutorialInput(environment: nil, archiveEnabled: false, now: afterRebuild))
  #expect(result.isComplete)
  #expect(state("finish", in: result).detail == "Archived is off")
}

@Test func tutorialArchivedPathResumesAsDoneWithoutLiveStopSnapshot() throws {
  let archives = try fixture("06-archived").archived!.map(\.projectRoot)
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(environment: nil, archivedProjectRoots: archives, now: afterRebuild, record: saved(at: "refresh")))
  #expect(result.isComplete)
  #expect(result.steps.allSatisfy { $0.state == .done })
}

@Test func tutorialSkipAndTimedMarkDonePersistAndResumeAtFirstUnfinishedStep() throws {
  var progress = TutorialProgress()
  _ = progress.update(
    TutorialInput(environment: try environment(), now: afterRebuild, record: saved(at: "phone", since: afterRebuild)))
  let tooEarly = progress.markDone(now: afterRebuild.addingTimeInterval(119))
  #expect(!tooEarly)
  let waiting = progress.update(TutorialInput(environment: try environment(), now: afterRebuild.addingTimeInterval(120)))
  #expect(state("phone", in: waiting).canMarkDone)
  let marked = progress.markDone(now: afterRebuild.addingTimeInterval(120))
  #expect(marked)
  progress.skip(now: afterRebuild.addingTimeInterval(121))
  var relaunched = TutorialProgress()
  let result = relaunched.update(
    TutorialInput(environment: try environment(), now: afterRebuild.addingTimeInterval(122), record: progress.record))
  #expect(result.currentStep == "finish")
  #expect(state("phone", in: result).state == .done)
  #expect(state("machine", in: result).state == .skipped)
}

@Test(arguments: [false, true])
func tutorialPendingRestartStillAcceptsViewerOpenAndInput(relaunch: Bool) throws {
  let env = try environment("04-live-clean")
  var progress = TutorialProgress()
  _ = progress.update(TutorialInput(environment: env, now: afterRebuild, record: saved(at: "device")))
  progress.requestRestart(now: afterRebuild)
  var input = TutorialInput(environment: env, now: afterRebuild.addingTimeInterval(1))
  if relaunch {
    input.record = try JSONDecoder().decode(TutorialRecord.self, from: JSONEncoder().encode(progress.record!))
    progress = TutorialProgress()
  }
  input.viewerEvents = [.opened("tutorial-simulator")]
  #expect(progress.update(input).currentStep == "device")
  input.viewerEvents = [.input("tutorial-simulator")]
  let result = progress.update(input)
  #expect(result.currentStep == "logs")
  #expect(state("device", in: result).state == .done)
}

@Test(arguments: ["live", "idle"])
func tutorialRestartWaitsForTrackedTourToDisappearAndReturnWithoutPhaseSince(phase: String) throws {
  var progress = TutorialProgress()
  var env = try environment("01-started")
  env.phase = phase
  _ = progress.update(TutorialInput(environment: env, now: afterRebuild, record: saved(at: "finish")))
  progress.requestRestart(now: afterRebuild)
  #expect(progress.update(TutorialInput(environment: env, now: afterRebuild)).currentStep == "finish")
  var other = env
  other.path = "/Users/example/other-tour"
  let absent = progress.update(TutorialInput(environment: other, now: afterRebuild.addingTimeInterval(1)))
  #expect(absent.currentStep == "finish")
  var relaunched = TutorialProgress()
  let persisted = try JSONDecoder().decode(TutorialRecord.self, from: JSONEncoder().encode(absent.record))
  let result = relaunched.update(TutorialInput(environment: env, now: afterRebuild.addingTimeInterval(10), record: persisted))
  #expect(result.currentStep == "sidebar")
  #expect(result.record.done == ["begin"])
  #expect(result.record.startedAt == afterRebuild.addingTimeInterval(10))
}

@Test func tutorialRestartRelaunchUsesOldestBuildEvenWithoutSeeingDisappearance() throws {
  var progress = TutorialProgress()
  let env = try environment("02-after-ios1")
  _ = progress.update(TutorialInput(environment: env, now: afterRebuild, record: saved(at: "finish")))
  progress.requestRestart(now: afterRebuild)
  let persisted = try JSONDecoder().decode(TutorialRecord.self, from: JSONEncoder().encode(progress.record!))
  var relaunched = TutorialProgress()
  var rebuilt = try environment()
  rebuilt.builds[0].build.startedAt = "2026-10-07T05:07:00.000Z"
  #expect(
    relaunched.update(TutorialInput(environment: rebuilt, now: afterRebuild.addingTimeInterval(120), record: persisted))
      .currentStep == "finish")
  rebuilt.builds = Array(rebuilt.builds.prefix(1))
  rebuilt.lastBuild = rebuilt.builds[0].build
  rebuilt.lastBuild?.finishedAt = "2026-10-07T05:07:30.000Z"
  rebuilt.builds[0].build = rebuilt.lastBuild!
  let result = relaunched.update(TutorialInput(environment: rebuilt, now: afterRebuild.addingTimeInterval(120)))
  #expect(result.currentStep == "rebuild")
  #expect(result.record.startedAt == parseTimestamp("2026-10-07T05:07:00.000Z"))
  #expect(!result.record.done.contains("refresh"))
}

@Test func tutorialOptionalStepsAcceptExistingPairingAndOnlyFreshOffload() throws {
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(
      environment: try environment(), pairedPhoneCount: 1, machineApproved: true,
      now: afterRebuild, record: saved(at: "phone", since: afterRebuild)))
  #expect(result.currentStep == "finish")
  #expect(state("phone", in: result).detail.contains("Open Stim on your phone"))
  #expect(state("machine", in: result).ticks.first { $0.id == "offloaded" }?.done == false)
  var env = try environment()
  env.lastBuild?.offloadedTo = "example-worker"
  env.lastBuild?.startedAt = "2026-10-07T05:07:00.000Z"
  let offloaded = progress.update(TutorialInput(environment: env, now: afterRebuild.addingTimeInterval(120)))
  #expect(state("machine", in: offloaded).ticks.first { $0.id == "offloaded" }?.done == true)
}

@Test func tutorialAgentWithoutAnIosDeviceDoesNotAcceptUntargetedActions() throws {
  var progress = TutorialProgress()
  let untargeted = try log("open", at: afterRebuild, source: "agent", event: "agent_action")
  let result = progress.update(
    TutorialInput(
      environment: try environment("01-started"), logRecords: [untargeted],
      now: afterRebuild, record: saved(at: "agent")))
  #expect(result.currentStep == "agent")
}

@Test func tutorialArchiveDisabledRelaunchRecognizesAnAlreadyRemovedTour() {
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(environment: nil, archiveEnabled: false, now: afterRebuild, record: saved(at: "finish")))
  #expect(result.isComplete)
  #expect(state("finish", in: result).detail == "Archived is off")
}

@Test func tutorialCompletedMachineTickStillRejectsOlderOffloadAfterRelaunch() throws {
  var progress = TutorialProgress()
  let completed = progress.update(
    TutorialInput(
      environment: try environment(), machineApproved: true,
      now: afterRebuild, record: saved(at: "machine", since: afterRebuild)))
  var env = try environment()
  env.lastBuild?.offloadedTo = "example-worker"
  var relaunched = TutorialProgress()
  let result = relaunched.update(TutorialInput(environment: env, now: afterRebuild, record: completed.record))
  #expect(state("machine", in: result).state == .done)
  #expect(state("machine", in: result).ticks.first { $0.id == "offloaded" }?.done == false)
}

@Test func tutorialPanelOpenedMidFirstBuildUsesBuildStart() throws {
  var env = try environment("01-started")
  env.build = try JSONDecoder().decode(
    Build.self,
    from: Data(
      """
      {"platform":"ios","slot":"default","state":"running","phase":"compile",
      "startedAt":"2026-10-07T04:57:09.000Z","phaseStartedAt":"2026-10-07T04:57:09.000Z","basis":0}
      """.utf8))
  var progress = TutorialProgress()
  let opened = progress.update(TutorialInput(environment: env, now: tourStart.addingTimeInterval(120)))
  #expect(opened.record.startedAt == env.build?.startedDate)
  #expect(opened.currentStep == "build")
  let result = progress.update(TutorialInput(environment: try environment("02-after-ios1"), now: afterBuild))
  #expect(result.currentStep == "rebuild")
}

@Test func tutorialSelectUsesNewestBuildAndDeterministicPathForLiveTours() throws {
  var first = try fixture("02-after-ios1").environments[0]
  var second = try fixture("03-after-rebuild").environments[0]
  second.path = "/Users/example/newer-tour"
  #expect(TutorialEnvironment.select([first, second], trackedPath: nil)?.path == second.path)
  #expect(TutorialEnvironment.select([second, first], trackedPath: nil)?.path == second.path)
  first.builds = nil
  first.lastBuilds = nil
  second.builds = nil
  second.lastBuilds = nil
  let selected = TutorialEnvironment.select([first, second], trackedPath: nil)?.path
  #expect(selected == TutorialEnvironment.select([second, first], trackedPath: nil)?.path)
}

@Test(arguments: ["build", "logs", "refresh"])
func tutorialArchiveDisabledRelaunchDoesNotCompleteBeforeFinish(step: String) {
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(environment: nil, archiveEnabled: false, now: afterRebuild, record: saved(at: step)))
  #expect(result.currentStep == step)
  #expect(!result.isComplete)
}

@Test func tutorialDuplicatedDeviceAndMetroErrorRecordsDoNotProveAgentReplay() throws {
  let action = afterRebuild.addingTimeInterval(1)
  let logs = try [
    log("open", at: afterRebuild, source: "agent", event: "agent_action", device: "tutorial-simulator"),
    log("error-button", at: action, level: "error"),
    log("error-button", at: action.addingTimeInterval(0.1), source: "metro", level: "error"),
    log("close", at: action.addingTimeInterval(1), source: "agent", event: "agent_action", device: "tutorial-simulator"),
  ]
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(
      environment: try environment(), logRecords: logs, now: afterRebuild.addingTimeInterval(3),
      record: saved(at: "agent", since: afterRebuild)))
  #expect(state("agent", in: result).ticks.first { $0.id == "agent-replay" }?.done == false)
}

@MainActor @Test func tutorialViewerEventHistoryRetainsOnlyLatest64Events() {
  let viewer = TutorialViewerEvents()
  viewer.opened("old-tour")
  for _ in 0..<64 { viewer.input("new-tour") }
  #expect(viewer.events.map(\.event) == Array(repeating: .input("new-tour"), count: 64))
  viewer.opened("latest-tour")
  #expect(viewer.events.last?.event == .opened("latest-tour"))
  #expect(viewer.events.count == 64)
}
