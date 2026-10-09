import Foundation
import Testing

@testable import StimKit

private let tourPath = "/Users/example/stim-tutorial-tour"
private let tourStart = parseTimestamp("2026-10-07T04:56:00.000Z")!
private let afterBuild = parseTimestamp("2026-10-07T05:02:00.000Z")!
private let afterRebuild = parseTimestamp("2026-10-07T05:06:00.000Z")!
private let stepIDs = [
  "begin", "build", "parallel", "device", "agent", "logs", "phone", "machine", "finish", "share",
]

private func fixture(_ name: String) throws -> StatusPayload {
  let url = Bundle.module.url(forResource: "tutorial-status-" + name, withExtension: "json", subdirectory: "Fixtures")!
  return try JSONDecoder().decode(StatusPayload.self, from: Data(contentsOf: url))
}

private func environment(_ name: String = "03-after-rebuild") throws -> TutorialEnvironment {
  var env = try TutorialEnvironment(fixture(name).environments[0])!
  env.version = 2
  return env
}

private func saved(at step: String, since: Date = tourStart) -> TutorialRecord {
  var record = TutorialRecord(
    version: 2, tourPath: tourPath, startedAt: tourStart, step: step,
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
  let record = TutorialRecord(version: 2, tourPath: tourPath, startedAt: afterRebuild)
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
      #"{"version":2,"startedAt":0,"step":"begin","done":[],"skipped":[],"manual":false}"#.utf8))
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
  #expect(progress.update(TutorialInput(environment: started, now: tourStart)).currentStep == "build")
  let result = progress.update(TutorialInput(environment: try environment("02-after-ios1"), now: afterBuild))
  #expect(result.currentStep == "parallel")
  #expect(state("build", in: result).state == .done)
  #expect(state("build", in: result).detail.contains("no earlier build"))
  #expect(state("build", in: result).ticks.contains { $0.id == "pods" && $0.done })
  #expect(!state("parallel", in: result).canMarkDone)
}

@Test func tutorialFirstBuildMayBeACacheHit() throws {
  var progress = TutorialProgress()
  var env = try environment()
  env.builds = Array(env.builds.prefix(1))
  let result = progress.update(TutorialInput(environment: env, now: afterRebuild, record: saved(at: "build")))
  #expect(state("build", in: result).state == .done)
  #expect(state("build", in: result).detail.contains("Local cache"))
  #expect(result.currentStep == "parallel")
}

private let secondPath = "/Users/example/stim-tutorial-second"

private func sibling(path: String = secondPath, repository: String? = "/Users/example/stim-tutorial") throws
  -> TutorialEnvironment
{
  var env = try environment()
  env.path = path
  env.repository = repository
  return env
}

@Test func tutorialParallelCompletesOnTheSecondWorkspacesCacheHit() throws {
  var base = try environment()
  base.repository = "/Users/example/stim-tutorial"
  let hit = try sibling()
  var progress = TutorialProgress()
  var input = TutorialInput(environment: base, siblings: [], now: afterRebuild, record: saved(at: "parallel"))
  let waiting = progress.update(input)
  #expect(waiting.currentStep == "parallel")
  #expect(waiting.record.secondPath == nil)
  input.siblings = [hit]
  let result = progress.update(input)
  #expect(result.record.secondPath == secondPath)
  #expect(result.currentStep == "device")
  #expect(state("parallel", in: result).detail.contains("Local cache"))
}

@Test func tutorialParallelStaysOnACompiledSecondBuildAndIgnoresOtherRepositories() throws {
  var base = try environment()
  base.repository = "/Users/example/stim-tutorial"
  var miss = try sibling()
  miss.lastBuild?.cacheHit = .none
  let foreign = try sibling(path: "/Users/example/other", repository: "/Users/example/elsewhere")
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(environment: base, siblings: [foreign, miss], now: afterRebuild, record: saved(at: "parallel")))
  #expect(result.record.secondPath == secondPath)
  #expect(result.currentStep == "parallel")
  #expect(state("parallel", in: result).detail.contains("Cache miss"))
  var other = TutorialProgress()
  let none = other.update(
    TutorialInput(environment: base, siblings: [foreign], now: afterRebuild, record: saved(at: "parallel")))
  #expect(none.record.secondPath == nil)
}

@Test func tutorialFailedBuildReportsDecodedCauseAndDiagnosticAndCanRecover() throws {
  let data = Data(
    """
    {"path":"/Users/example/stim-tutorial-tour","live":true,"warnings":[],"tutorial":{"version":2},
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
  #expect(recovered.currentStep == "parallel")
}

@Test func tutorialRelaunchReevaluatesBuildsCompletedWhileClosed() throws {
  let suite = "TutorialProgressTests-" + UUID().uuidString
  let defaults = UserDefaults(suiteName: suite)!
  defer { defaults.removePersistentDomain(forName: suite) }
  let store = TutorialRecordStore(defaults)
  var record = saved(at: "build")
  record.step = "parallel"
  record.approvedMachine = "Studio"
  store.record = record
  let relaunchedStore = TutorialRecordStore(defaults)
  var progress = TutorialProgress()
  let result = progress.update(TutorialInput(environment: try environment(), now: afterRebuild, record: relaunchedStore.record))
  #expect(result.currentStep == "parallel")
  #expect(state("build", in: result).state == .done)
  #expect(result.shouldReopen)
  #expect(result.record.approvedMachine == "Studio")
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
    (3, "Update Stim Desktop to follow this tutorial"), (1, "Restart the tutorial with the current Stim CLI"),
  ] {
    var env = try environment()
    env.version = version
    var progress = TutorialProgress()
    let result = progress.update(TutorialInput(environment: env, now: afterRebuild, record: saved(at: "parallel")))
    #expect(result.currentStep == "parallel")
    #expect(state("parallel", in: result).state == .failed(message))
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
  #expect(progress.update(input).currentStep == "agent")
  env = try environment("05-stopped")
  var stopped = TutorialProgress()
  let result = stopped.update(TutorialInput(environment: env, now: afterRebuild, record: saved(at: "device")))
  #expect(state("device", in: result).state == .failed("Ask your agent to run the app again"))
}

@Test func tutorialAgentRequiresFreshActionOnTourDevice() throws {
  var progress = TutorialProgress()
  let actionDate = afterRebuild.addingTimeInterval(1)
  let early = try log("press", at: afterBuild, source: "agent", event: "agent_action", device: "tutorial-simulator")
  let wrong = try log("press", at: actionDate, source: "agent", event: "agent_action", device: "other")
  let failed = try log("replay", at: actionDate, source: "agent", event: "agent_failed", device: "tutorial-simulator")
  var input = TutorialInput(
    environment: try environment(), logRecords: [early, wrong, failed], now: actionDate,
    record: saved(at: "agent", since: afterRebuild))
  #expect(progress.update(input).currentStep == "agent")
  input.logRecords = [
    try log("open", at: actionDate, source: "agent", event: "agent_action", device: "tutorial-simulator", command: "open")
  ]
  let result = progress.update(input)
  #expect(result.currentStep == "logs")
  #expect(state("agent", in: result).ticks.first { $0.id == "action" }?.done == true)
}

@Test func tutorialLogsStepWaitsForTheUserToMarkItDone() throws {
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(
      environment: try environment(), logRecords: [try log("anything", at: afterRebuild)], now: afterRebuild,
      record: saved(at: "logs", since: afterRebuild)))
  #expect(result.currentStep == "logs")
}

@Test func tutorialFinishCompletesWithArchiveWithoutIntermediateStopSnapshot() throws {
  var progress = TutorialProgress()
  _ = progress.update(TutorialInput(environment: try environment(), now: afterRebuild, record: saved(at: "finish")))
  let archives = try fixture("06-archived").archived!.map(\.projectRoot)
  let result = progress.update(TutorialInput(environment: nil, archivedProjectRoots: archives, now: afterRebuild))
  #expect(result.isComplete)
  #expect(result.currentStep == "share")
  #expect(state("finish", in: result).state == .done)
  #expect(state("finish", in: result).ticks.first { $0.id == "stopped" }?.done == false)
  #expect(state("finish", in: result).ticks.first { $0.id == "archived" }?.done == true)
}

@Test func tutorialFinishNeedsBothWorktreesGoneAndArchived() throws {
  var base = try environment()
  base.repository = "/Users/example/stim-tutorial"
  var record = saved(at: "finish")
  record.secondPath = secondPath
  let archives = try fixture("06-archived").archived!.map(\.projectRoot)
  var progress = TutorialProgress()
  _ = progress.update(TutorialInput(environment: base, siblings: [try sibling()], now: afterRebuild, record: record))
  let stillThere = progress.update(
    TutorialInput(environment: nil, siblings: [try sibling()], archivedProjectRoots: archives, now: afterRebuild))
  #expect(stillThere.currentStep == "finish")
  let firstOnly = progress.update(TutorialInput(environment: nil, archivedProjectRoots: archives, now: afterRebuild))
  #expect(firstOnly.currentStep == "finish")
  #expect(state("finish", in: firstOnly).ticks.first { $0.id == "archived" }?.done == false)
  let both = progress.update(
    TutorialInput(environment: nil, archivedProjectRoots: archives + [secondPath], now: afterRebuild))
  #expect(both.currentStep == "share")
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
    TutorialInput(environment: nil, archivedProjectRoots: archives, now: afterRebuild, record: saved(at: "finish")))
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
  #expect(result.currentStep == "agent")
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
  #expect(result.currentStep == "build")
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
  #expect(result.currentStep == "parallel")
  #expect(result.record.startedAt == parseTimestamp("2026-10-07T05:07:00.000Z"))
}

@Test func tutorialOptionalStepsAcceptExistingPairingAndOnlyFreshOffload() throws {
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(
      environment: try environment(), pairedPhoneCount: 1, machineApproved: true,
      now: afterRebuild, record: saved(at: "phone", since: afterRebuild)))
  #expect(result.currentStep == "finish")
  #expect(result.record.phonePairedAtStart == true)
  #expect(state("phone", in: result).detail.contains("Open Stim on your phone"))
  #expect(state("machine", in: result).ticks.first { $0.id == "offloaded" }?.done == false)
  var env = try environment()
  env.lastBuild?.offloadedTo = "example-worker"
  env.lastBuild?.startedAt = "2026-10-07T05:07:00.000Z"
  let offloaded = progress.update(TutorialInput(environment: env, now: afterRebuild.addingTimeInterval(120)))
  #expect(state("machine", in: offloaded).ticks.first { $0.id == "offloaded" }?.done == true)
}

@Test func tutorialPhonePairingDuringStepDoesNotBecomeAnExistingPairingAfterRelaunch() throws {
  var progress = TutorialProgress()
  var input = TutorialInput(
    environment: try environment(), pairedPhoneCount: 0, now: afterRebuild,
    record: saved(at: "phone", since: afterRebuild))
  let waiting = progress.update(input)
  #expect(waiting.currentStep == "phone")
  input.record = try JSONDecoder().decode(TutorialRecord.self, from: JSONEncoder().encode(waiting.record))
  var relaunched = TutorialProgress()
  input.pairedPhoneCount = 1
  let paired = relaunched.update(input)
  #expect(state("phone", in: paired).state == .done)
  #expect(paired.record.phonePairedAtStart == false)
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
  #expect(result.currentStep == "parallel")
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

@Test(arguments: ["build", "logs", "agent"])
func tutorialArchiveDisabledRelaunchDoesNotCompleteBeforeFinish(step: String) {
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(environment: nil, archiveEnabled: false, now: afterRebuild, record: saved(at: step)))
  #expect(result.currentStep == step)
  #expect(!result.isComplete)
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

@Test func tutorialSkipsThePhoneStepWithoutThePhoneApp() throws {
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(
      environment: try environment(), phoneApp: false, now: afterRebuild, record: saved(at: "phone", since: afterRebuild)))
  #expect(result.currentStep == "machine")
  #expect(result.steps.map(\.id) == stepIDs.filter { $0 != "phone" })
  #expect(!result.record.skipped.contains("phone"))
}

@Test func tutorialShowsThePhoneStepWithThePhoneApp() throws {
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(
      environment: try environment(), phoneApp: true, now: afterRebuild, record: saved(at: "phone", since: afterRebuild)))
  #expect(result.currentStep == "phone")
  #expect(result.steps.map(\.id) == stepIDs)
}
