import Foundation
import Testing

@testable import StimKit

private let tourPath = "/Users/example/stim-tutorial-tour"
private let tourStart = parseTimestamp("2026-10-07T04:56:00.000Z")!
private let afterBuild = parseTimestamp("2026-10-07T05:02:00.000Z")!
private let afterRebuild = parseTimestamp("2026-10-07T05:06:00.000Z")!
private let stepIDs = [
  "begin", "build", "parallel", "device", "agent", "logs", "phone", "share", "finish", "delete",
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

private func linked(_ workspace: Workspace, repository: String = "/Users/example/stim-tutorial") throws -> Workspace {
  var workspace = workspace
  workspace.tutorial = TutorialMarker(version: 2)
  workspace.worktree = try JSONDecoder().decode(
    WorktreeInfo.self, from: Data(#"{"path":"\#(workspace.path)","repository":"\#(repository)"}"#.utf8))
  return workspace
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
  store.record = record
  let relaunchedStore = TutorialRecordStore(defaults)
  var progress = TutorialProgress()
  let result = progress.update(TutorialInput(environment: try environment(), now: afterRebuild, record: relaunchedStore.record))
  #expect(result.currentStep == "parallel")
  #expect(state("build", in: result).state == .done)
  #expect(result.shouldReopen)
}

@Test func tutorialTracksSavedPathOtherwiseTheOldestWorktree() throws {
  var first = try fixture("01-started").environments[0]
  first.phaseSince = "2026-10-07T04:56:00.000Z"
  var second = first
  second.path = "/Users/example/second-tour"
  second.phaseSince = "2026-10-07T05:06:00.000Z"
  first = try linked(first)
  second = try linked(second)
  #expect(TutorialEnvironment.select([first, second], trackedPath: tourPath)?.path == tourPath)
  #expect(TutorialEnvironment.select([first, second], trackedPath: nil)?.path == first.path)
  #expect(TutorialEnvironment.select([first, second], trackedPath: "/missing")?.path == first.path)
  var clone = first
  clone.path = "/Users/example/stim-tutorial"
  #expect(TutorialEnvironment.select([clone], trackedPath: nil) == nil)
}

@Test func tutorialUnsupportedVersionsFailBeforeAcceptingSignals() throws {
  for (version, message, action) in [
    (3, "Update Stim Desktop to follow this tutorial", TutorialAction.updateDesktop),
    (1, "This tutorial was started with an older version. Restart it to follow the new steps.", .restart),
  ] {
    var env = try environment()
    env.version = version
    var progress = TutorialProgress()
    let result = progress.update(TutorialInput(environment: env, now: afterRebuild, record: saved(at: "parallel")))
    #expect(result.currentStep == "parallel")
    #expect(state("parallel", in: result).state == .failed(message))
    #expect(state("parallel", in: result).action == action)
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
  #expect(state("device", in: result).state == .current)
  #expect(state("device", in: result).detail == "Run the app first, then open its live view")
}

@Test func tutorialDeviceTicksTheSecondChangesLiveViewToo() throws {
  let tour = try environment("04-live-clean")
  var second = tour
  second.path = "/Users/example/stim-tutorial-second"
  second.ios?.udid = "second-simulator"
  var record = saved(at: "device")
  record.secondPath = second.path
  var progress = TutorialProgress()
  var input = TutorialInput(
    environment: tour, siblings: [tour, second], viewerEvents: [.opened("second-simulator")], now: afterRebuild,
    record: record)
  var result = progress.update(input)
  #expect(result.currentStep == "device")
  #expect(state("device", in: result).ticks.map(\.done) == [true, false])
  input.viewerEvents = [.input("second-simulator")]
  result = progress.update(input)
  #expect(result.currentStep == "agent")
  #expect(state("device", in: result).state == .done)
}

@Test func tutorialAgentTicksViewerEventsOnTheTourDeviceAndNextRecordsItDone() throws {
  var progress = TutorialProgress()
  let checked = try log("press", at: afterBuild, source: "agent", event: "agent_action", device: "tutorial-simulator")
  var input = TutorialInput(
    environment: try environment(), logRecords: [checked],
    viewerEvents: [.actionsViewed("other"), .replayPlayed("other")], now: afterRebuild,
    record: saved(at: "agent", since: afterRebuild))
  var result = progress.update(input)
  #expect(state("agent", in: result).detail.isEmpty)
  #expect(state("agent", in: result).ticks.allSatisfy { !$0.done })
  input.viewerEvents = [.actionsViewed("tutorial-simulator"), .replayPlayed("tutorial-simulator")]
  result = progress.update(input)
  #expect(result.currentStep == "agent")
  #expect(state("agent", in: result).ticks.map(\.done) == [true, true])
  progress.next(now: afterRebuild.addingTimeInterval(1))
  result = progress.update(TutorialInput(environment: try environment(), now: afterRebuild.addingTimeInterval(1)))
  #expect(result.currentStep == "logs")
  #expect(state("agent", in: result).state == .done)
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
  #expect(result.currentStep == "delete")
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
  #expect(both.currentStep == "delete")
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
  #expect(state("finish", in: missing).action == .restart)
  let result = progress.update(TutorialInput(environment: nil, archiveEnabled: false, now: afterRebuild))
  #expect(result.currentStep == "delete")
  #expect(state("finish", in: result).detail == "Archived is off")
}

@Test func tutorialArchivedPathResumesAsDoneWithoutLiveStopSnapshot() throws {
  let archives = try fixture("06-archived").archived!.map(\.projectRoot)
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(environment: nil, archivedProjectRoots: archives, now: afterRebuild, record: saved(at: "finish")))
  #expect(result.currentStep == "delete")
  #expect(result.steps.filter { $0.id != "delete" }.allSatisfy { $0.state == .done })
}

@Test func tutorialDeleteCompletesOnlyOnceTheCloneIsUnregisteredAndItsFolderIsGone() throws {
  var record = saved(at: "delete")
  record.clonePath = "/Users/example/stim-tutorial"
  var clone = try environment()
  clone.path = "/Users/example/stim-tutorial"
  clone.repository = clone.path
  var progress = TutorialProgress()
  let registered = progress.update(
    TutorialInput(environment: nil, siblings: [clone], cloneFolderExists: false, now: afterRebuild, record: record))
  #expect(registered.currentStep == "delete")
  #expect(state("delete", in: registered).ticks.map(\.done) == [true, false])
  let folderLeft = progress.update(TutorialInput(environment: nil, cloneFolderExists: true, now: afterRebuild))
  #expect(folderLeft.currentStep == "delete")
  let gone = progress.update(TutorialInput(environment: nil, cloneFolderExists: false, now: afterRebuild))
  #expect(gone.isComplete)
  #expect(state("delete", in: gone).state == .done)
}

@Test func tutorialCompletedBeforeTheDeleteStepExistedStaysComplete() throws {
  var record = saved(at: "done")
  record.done = stepIDs.filter { $0 != "delete" }
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(environment: nil, cloneFolderExists: true, now: afterRebuild, record: record))
  #expect(result.isComplete)
}

@Test func tutorialNextOnAnUndetectedStepRecordsSkippedAndResumesAtTheFirstUnfinishedStep() throws {
  var progress = TutorialProgress()
  _ = progress.update(
    TutorialInput(environment: try environment(), now: afterRebuild, record: saved(at: "phone", since: afterRebuild)))
  progress.next(now: afterRebuild.addingTimeInterval(1))
  progress.next(now: afterRebuild.addingTimeInterval(2))
  var relaunched = TutorialProgress()
  let result = relaunched.update(
    TutorialInput(environment: try environment(), now: afterRebuild.addingTimeInterval(3), record: progress.record))
  #expect(result.currentStep == "finish")
  #expect(state("phone", in: result).state == .skipped)
  #expect(state("share", in: result).state == .skipped)
}

@Test func tutorialPhoneStepAcceptsAnExistingPairing() throws {
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(
      environment: try environment(), pairedPhoneCount: 1,
      now: afterRebuild, record: saved(at: "phone", since: afterRebuild)))
  #expect(result.currentStep == "share")
  #expect(result.record.phonePairedAtStart == true)
  #expect(state("phone", in: result).detail.contains("Open Stim on your phone"))
}

@Test func tutorialRecordsFromTheRemovedMachineStepResumeAtTheNextStep() throws {
  let atMachine = try JSONDecoder().decode(
    TutorialRecord.self,
    from: Data(
      #"""
      {"version":2,"tourPath":"\#(tourPath)","startedAt":0,"step":"machine","approvedMachine":"Studio",
       "done":["begin","build","parallel","device","agent","logs","phone"],"skipped":[]}
      """#.utf8))
  var progress = TutorialProgress()
  let resumed = progress.update(TutorialInput(environment: try environment(), now: afterRebuild, record: atMachine))
  #expect(resumed.currentStep == "share")
  #expect(!resumed.steps.contains { $0.id == "machine" })
  var pastMachine = atMachine
  pastMachine.step = "share"
  pastMachine.skipped = ["machine"]
  var relaunched = TutorialProgress()
  let later = relaunched.update(TutorialInput(environment: try environment(), now: afterRebuild, record: pastMachine))
  #expect(later.currentStep == "share")
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

@Test func tutorialAgentSaysNoActionsWereRecordedForOtherDevicesOrFailures() throws {
  var progress = TutorialProgress()
  let wrong = try log("press", at: afterRebuild, source: "agent", event: "agent_action", device: "other")
  let failed = try log("press", at: afterRebuild, source: "agent", event: "agent_failed", device: "tutorial-simulator")
  let result = progress.update(
    TutorialInput(
      environment: try environment(), logRecords: [wrong, failed], now: afterRebuild, record: saved(at: "agent")))
  #expect(result.currentStep == "agent")
  #expect(state("agent", in: result).detail.hasPrefix("No agent actions"))
}

@Test func tutorialArchiveDisabledRelaunchRecognizesAnAlreadyRemovedTour() {
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(environment: nil, archiveEnabled: false, now: afterRebuild, record: saved(at: "finish")))
  #expect(result.currentStep == "delete")
  #expect(state("finish", in: result).detail == "Archived is off")
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

@Test func tutorialSelectIsDeterministicForLiveTours() throws {
  var first = try linked(fixture("02-after-ios1").environments[0])
  var second = try linked(fixture("03-after-rebuild").environments[0])
  second.path = "/Users/example/newer-tour"
  second = try linked(second)
  #expect(
    TutorialEnvironment.select([first, second], trackedPath: nil)?.path
      == TutorialEnvironment.select([second, first], trackedPath: nil)?.path)
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
  #expect(result.currentStep == "share")
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

@Test func tutorialSelectPrefersASupportedVersionOverANewerOldOne() throws {
  var current = try linked(fixture("02-after-ios1").environments[0])
  current.tutorial = TutorialMarker(version: 2)
  var old = try fixture("03-after-rebuild").environments[0]
  old.path = "/Users/example/old-tour"
  old = try linked(old)
  old.tutorial = TutorialMarker(version: 1)
  #expect(TutorialEnvironment.select([current, old], trackedPath: nil)?.path == current.path)
  #expect(TutorialEnvironment.select([old], trackedPath: nil)?.path == old.path)
}

@Test func tutorialBeginCompletesOnlyForACloneRegisteredAfterTheStart() throws {
  var older = try environment("01-started")
  older.path = "/Users/example/older-clone"
  older.repository = older.path
  var fresh = try environment("01-started")
  fresh.repository = fresh.path
  var progress = TutorialProgress()
  let before = progress.update(TutorialInput(environment: nil, siblings: [older], now: afterBuild))
  #expect(before.currentStep == "begin")
  #expect(before.record.baselineClones == [older.path])
  let after = progress.update(TutorialInput(environment: nil, siblings: [older, fresh], now: afterBuild))
  #expect(state("begin", in: after).state == .done)
  #expect(after.currentStep == "build")
  #expect(after.record.clonePath == fresh.path)
  #expect(after.record.tourPath == nil)
}

private func clone(_ path: String, doctorRanAt: Date? = nil) throws -> TutorialEnvironment {
  var env = try environment("01-started")
  env.path = path
  env.repository = path
  env.iosDoctorRanAt = doctorRanAt
  return env
}

@Test func tutorialBeginCompletesForACloneRecreatedAtABaselinePath() throws {
  let path = "/Users/example/stim-tutorial"
  var progress = TutorialProgress()
  let before = progress.update(
    TutorialInput(
      environment: nil, siblings: [try clone(path, doctorRanAt: afterBuild.addingTimeInterval(-3600))], now: afterBuild))
  #expect(before.currentStep == "begin")
  #expect(before.record.baselineClones == [path])
  let stale = progress.update(
    TutorialInput(
      environment: nil, siblings: [try clone(path, doctorRanAt: afterBuild.addingTimeInterval(-3600))],
      now: afterBuild.addingTimeInterval(30)))
  #expect(stale.currentStep == "begin")
  let recloned = progress.update(
    TutorialInput(
      environment: nil, siblings: [try clone(path, doctorRanAt: afterBuild.addingTimeInterval(60))],
      now: afterBuild.addingTimeInterval(90)))
  #expect(state("begin", in: recloned).state == .done)
  #expect(recloned.currentStep == "build")
  #expect(recloned.record.clonePath == path)
}

@Test func tutorialReleasesAPinnedCloneThatDisappearsBeforeAnyWorktree() throws {
  let first = "/Users/example/clone-a"
  let second = "/Users/example/clone-b"
  var progress = TutorialProgress()
  _ = progress.update(TutorialInput(environment: nil, siblings: [], now: afterBuild))
  let pinned = progress.update(
    TutorialInput(
      environment: nil, siblings: [try clone(first, doctorRanAt: afterBuild.addingTimeInterval(10))],
      now: afterBuild.addingTimeInterval(20)))
  #expect(pinned.record.clonePath == first)
  let released = progress.update(TutorialInput(environment: nil, siblings: [], now: afterBuild.addingTimeInterval(30)))
  #expect(released.record.clonePath == nil)
  let adopted = progress.update(
    TutorialInput(
      environment: nil, siblings: [try clone(second, doctorRanAt: afterBuild.addingTimeInterval(40))],
      now: afterBuild.addingTimeInterval(50)))
  #expect(adopted.record.clonePath == second)
}

@Test func tutorialCloneHintOnlyAppliesToThePinnedClone() throws {
  let pinnedPath = "/Users/example/clone-a"
  let otherPath = "/Users/example/clone-b"
  let built = try environment("03-after-rebuild")
  func hint(pinnedBuilt: Bool, otherBuilt: Bool) throws -> String {
    var pinned = try clone(pinnedPath, doctorRanAt: afterBuild.addingTimeInterval(20))
    var other = try clone(otherPath, doctorRanAt: afterBuild.addingTimeInterval(10))
    if pinnedBuilt { pinned.lastBuild = built.lastBuild }
    if otherBuilt { other.lastBuild = built.lastBuild }
    var record = TutorialRecord(version: 2, startedAt: tourStart, step: "build", done: ["begin"])
    record.stepSince = tourStart
    record.clonePath = pinnedPath
    record.baselineClones = []
    var progress = TutorialProgress()
    let result = progress.update(
      TutorialInput(environment: nil, siblings: [other, pinned], now: afterRebuild, record: record))
    return state("build", in: result).detail
  }
  #expect(try hint(pinnedBuilt: false, otherBuilt: true) == "Waiting for the iOS build")
  #expect(try hint(pinnedBuilt: true, otherBuilt: false).hasPrefix("Ask your agent to make the change"))
}

@Test func tutorialTourOnlyComesFromTheClonePinnedByBegin() throws {
  var mine = try linked(fixture("01-started").environments[0], repository: "/Users/example/clone-a")
  mine.phaseSince = "2026-10-07T05:10:00.000Z"
  var other = mine
  other.path = "/Users/example/other-clone-worktree"
  other.phaseSince = "2026-10-07T05:05:00.000Z"
  other = try linked(other, repository: "/Users/example/clone-b")
  let start = parseTimestamp("2026-10-07T05:00:00.000Z")!
  #expect(TutorialEnvironment.select([other, mine], trackedPath: nil, since: start)?.path == mine.path)
  #expect(
    TutorialEnvironment.select([other, mine], trackedPath: nil, since: start, repository: "/Users/example/clone-b")?.path
      == other.path)
}

@Test func tutorialSecondWorkspaceMustBeLinkedAndNewerThanTheFirstChangeStep() throws {
  var base = try environment()
  base.repository = "/Users/example/stim-tutorial"
  var record = saved(at: "parallel", since: afterBuild)
  record.stepTimes = ["build": afterBuild]
  let old = try sibling(path: "/Users/example/leftover")
  var clone = try sibling(path: "/Users/example/stim-tutorial")
  clone.repository = clone.path
  var progress = TutorialProgress()
  let stale = progress.update(
    TutorialInput(environment: base, siblings: [old, clone], now: afterRebuild, record: record))
  #expect(stale.record.secondPath == nil)
  #expect(stale.currentStep == "parallel")
  var fresh = try sibling()
  fresh.phaseSince = afterBuild.addingTimeInterval(30)
  fresh.lastBuild?.startedAt = "2026-10-07T04:00:00.000Z"
  let oldBuild = progress.update(TutorialInput(environment: base, siblings: [old, fresh], now: afterRebuild))
  #expect(oldBuild.record.secondPath == secondPath)
  #expect(oldBuild.currentStep == "parallel")
  fresh.lastBuild?.startedAt = "2026-10-07T05:03:00.000Z"
  let done = progress.update(TutorialInput(environment: base, siblings: [fresh], now: afterRebuild))
  #expect(done.currentStep == "device")
}

@Test func tutorialSelectAdoptsTheOldestWorktreeAfterTheStartAndIgnoresOlderOnes() throws {
  var first = try linked(fixture("01-started").environments[0])
  first.phaseSince = "2026-10-07T05:00:00.000Z"
  var second = first
  second.path = "/Users/example/second-tour"
  second.phaseSince = "2026-10-07T05:10:00.000Z"
  second = try linked(second)
  var leftover = first
  leftover.path = "/Users/example/leftover"
  leftover.phaseSince = "2026-10-06T05:00:00.000Z"
  leftover = try linked(leftover)
  let tracked = TutorialEnvironment.select([second, leftover, first], trackedPath: nil)
  #expect(tracked?.path == leftover.path)
  let start = parseTimestamp("2026-10-07T04:59:00.000Z")!
  #expect(TutorialEnvironment.select([second, leftover, first], trackedPath: nil, since: start)?.path == first.path)
  var idle = first
  idle.path = "/Users/example/idle"
  idle.phaseSince = nil
  idle.builds = nil
  idle.lastBuilds = nil
  idle = try linked(idle)
  #expect(TutorialEnvironment.select([idle], trackedPath: nil, since: start) == nil)
}

@Test func tutorialFirstChangeInTheCloneGetsAWorktreeHintOnlyForNewBuilds() throws {
  var clone = try environment()
  clone.repository = clone.path
  var idle = clone
  idle.builds = []
  idle.lastBuild = nil
  var progress = TutorialProgress()
  _ = progress.update(TutorialInput(environment: nil, siblings: [], now: tourStart))
  let registered = progress.update(TutorialInput(environment: nil, siblings: [idle], now: afterBuild))
  #expect(registered.currentStep == "build")
  #expect(!state("build", in: registered).detail.contains("new worktree"))
  clone.lastBuild?.startedAt = "2026-10-07T05:03:00.000Z"
  let built = progress.update(TutorialInput(environment: nil, siblings: [clone], now: afterRebuild))
  #expect(state("build", in: built).detail.contains("new worktree"))
  clone.lastBuild?.startedAt = "2026-10-07T05:00:00.000Z"
  let older = progress.update(TutorialInput(environment: nil, siblings: [clone], now: afterRebuild))
  #expect(!state("build", in: older).detail.contains("new worktree"))
}

@Test func tutorialSecondWorkspaceNeedsACreationTimeAfterTheStep() throws {
  var base = try environment()
  base.repository = "/Users/example/stim-tutorial"
  var idle = try sibling()
  idle.phaseSince = nil
  idle.builds = []
  idle.lastBuild = nil
  var progress = TutorialProgress()
  let result = progress.update(
    TutorialInput(environment: base, siblings: [idle], now: afterRebuild, record: saved(at: "parallel")))
  #expect(result.record.secondPath == nil)
}

@Test func tutorialBeginIgnoresARegisteredCloneFromAnOlderTutorialVersion() throws {
  var clone = try environment("01-started")
  clone.repository = clone.path
  clone.version = 1
  var progress = TutorialProgress()
  let result = progress.update(TutorialInput(environment: nil, siblings: [clone], now: afterBuild))
  #expect(result.currentStep == "begin")
}

@Test func tutorialCloneFolderStagesFollowTheCheckoutAndTheNpmMarker() {
  let start = tourStart
  let fresh = start.addingTimeInterval(5)
  #expect(TutorialCloneFolder(created: nil).stage(since: start) == .absent)
  #expect(
    TutorialCloneFolder(created: start.addingTimeInterval(-60), checkedOut: true, dependenciesInstalled: true)
      .stage(since: start) == .absent)
  #expect(TutorialCloneFolder(created: fresh).stage(since: start) == .cloning)
  #expect(TutorialCloneFolder(created: fresh, checkedOut: true).stage(since: start) == .cloned)
  #expect(TutorialCloneFolder(created: fresh, checkedOut: true, dependenciesFolder: true).stage(since: start) == .installing)
  #expect(
    TutorialCloneFolder(created: fresh, checkedOut: true, dependenciesFolder: true, dependenciesInstalled: true)
      .stage(since: start) == .installed)
}

@Test func tutorialCloneFolderReadsTheCloneLayout() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("tutorial-clone-" + UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: root) }
  let start = Date().addingTimeInterval(-5)
  #expect(TutorialCloneFolder(path: root.path).stage(since: start) == .absent)
  try FileManager.default.createDirectory(at: root.appendingPathComponent(".git"), withIntermediateDirectories: true)
  #expect(TutorialCloneFolder(path: root.path).stage(since: start) == .cloning)
  try Data("ref: refs/heads/main\n".utf8).write(to: root.appendingPathComponent(".git/HEAD"))
  try Data("{}".utf8).write(to: root.appendingPathComponent("package.json"))
  #expect(TutorialCloneFolder(path: root.path).stage(since: start) == .cloned)
  try FileManager.default.createDirectory(at: root.appendingPathComponent("node_modules"), withIntermediateDirectories: true)
  #expect(TutorialCloneFolder(path: root.path).stage(since: start) == .installing)
  try Data("{}".utf8).write(to: root.appendingPathComponent("node_modules/.package-lock.json"))
  #expect(TutorialCloneFolder(path: root.path).stage(since: start) == .installed)
}

@Test func tutorialBeginShowsCloneProgressAndStillOffersRestartAfterTheTimeout() throws {
  var record = TutorialRecord(version: 2, startedAt: tourStart)
  record.runPromptCopiedAt = tourStart
  let late = tourStart.addingTimeInterval(600)
  var progress = TutorialProgress()
  let installing = progress.update(
    TutorialInput(
      environment: nil,
      newCloneFolder: TutorialCloneFolder(
        created: tourStart.addingTimeInterval(10), checkedOut: true, dependenciesFolder: true),
      now: late, record: record))
  #expect(state("begin", in: installing).detail == "Installing dependencies...")
  #expect(state("begin", in: installing).action == .restart)
  #expect(state("begin", in: installing).ticks.map(\.done) == [true, false, false])
  let stale = progress.update(
    TutorialInput(environment: nil, newCloneFolder: TutorialCloneFolder(created: tourStart.addingTimeInterval(-10)), now: late))
  #expect(state("begin", in: stale).detail == "No tutorial workspace yet. Ask your agent what failed")
}
