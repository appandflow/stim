import Foundation
import Testing

@testable import StimKit

private let now = ISO8601DateFormatter().date(from: "2026-09-27T12:00:00Z")!

private func iso(_ secondsAgo: TimeInterval) -> String {
  ISO8601DateFormatter().string(from: now.addingTimeInterval(-secondsAgo))
}

private func workspace(_ fields: String) throws -> Workspace {
  var object: [String: Any] = ["path": "/w", "live": true, "phase": "live", "memoryMb": 0, "warnings": []]
  let patch = try JSONSerialization.jsonObject(with: Data("{\(fields)}".utf8)) as! [String: Any]
  object.merge(patch) { _, new in new }
  return try JSONDecoder().decode(Workspace.self, from: JSONSerialization.data(withJSONObject: object))
}

private func lastBuild(
  _ platform: String = "ios", status: String = "ok", cacheHit: String = "\"local\"",
  durationMs: Int = 33_000, startedAgo: TimeInterval = 27 * 60, finishedAgo: TimeInterval = 26 * 60
) -> String {
  #"{"platform":"\#(platform)","status":"\#(status)","cacheHit":\#(cacheHit),"durationMs":\#(durationMs),"startedAt":"\#(iso(startedAgo))","finishedAt":"\#(iso(finishedAgo))"}"#
}

private func runningBuild(_ extra: String = "") -> String {
  #"{"platform":"ios","slot":"default","state":"running","phase":"compile","startedAt":"\#(iso(72))","phaseStartedAt":"\#(iso(47))","outcome":"cold","expectedMs":160000,"expectedPhaseMs":94000,"basis":3\#(extra)}"#
}

private let booted = #"{"name":"stim-w (iPhone 18 27.0)","udid":"SIM-1","owned":true,"state":"Booted""#

@Suite struct WorkspaceStageTests {
  @Test func namesEachStageWithItsSubtitle() throws {
    #expect(
      try workspace(#""supervisor":{"startedAt":"\#(iso(42 * 60))","healthy":true}"#).stage(now: now)
        == WorkspaceStage(label: .running, tone: .success, subtitle: "up 42m"))
    #expect(
      try workspace(#""build":\#(runningBuild())"#).stage(now: now)
        == WorkspaceStage(label: .building, tone: .brand, subtitle: "iOS \u{00B7} started 1m ago"))
    #expect(
      try workspace(#""lastBuilds":{"ios":\#(lastBuild(status: "failed", finishedAgo: 180))}"#).stage(now: now)
        == WorkspaceStage(label: .buildFailed, tone: .error, subtitle: "iOS \u{00B7} 3m ago"))
    #expect(
      try workspace(#""live":false,"phase":"warming","warmStep":"refresh","phaseSince":"\#(iso(120))""#)
        .stage(now: now) == WorkspaceStage(label: .warming, tone: .warning, subtitle: "installing dependencies \u{00B7} 2m"))
    #expect(
      try workspace(#""live":false,"phase":"ready","phaseSince":"\#(iso(48 * 60))""#).stage(now: now)
        == WorkspaceStage(label: .ready, tone: .success, subtitle: "warmed 48m ago"))
    #expect(
      try workspace(
        #""live":false,"phase":"idle","metro":{"port":8084,"running":false,"lastStop":{"reason":"idle","at":"\#(iso(7200))"}}"#
      ).stage(now: now) == WorkspaceStage(label: .stopped, tone: .tertiary, subtitle: "2h ago"))
  }

  @Test func turnsARunningWorkspaceRedForLogErrorsOrAClosedApp() throws {
    let crashed = try workspace(
      #""logs":{"dir":"","errorsSinceMarker":3},"ios":\#(booted),"app":{"id":"a","state":"stopped"}}"#)
    #expect(
      crashed.stage(now: now) == WorkspaceStage(label: .running, tone: .error, subtitle: "3 errors \u{00B7} iOS app closed"))
  }

  @Test func readsTheNewestBuildSoAnOlderFailureDoesNotMaskANewerSuccess() throws {
    let env = try workspace(
      #""lastBuilds":{"ios":\#(lastBuild(status: "failed", startedAgo: 3600)),"android":\#(lastBuild("android", startedAgo: 300))}"#
    )
    #expect(env.stage(now: now).label == .running)
  }
}

@Suite struct AppPresenceTests {
  private func entry(_ result: String) -> String {
    String(lastBuild().dropLast()) + #","result":"\#(result)","slot":"default","phases":{}}"#
  }

  @Test func saysNoAppOnlyWhenTheLatestBuildFailedAndNoneEverSucceeded() throws {
    let stopped = #"\#(booted),"app":{"id":"a","state":"stopped"}}"#
    let failed = #""lastBuilds":{"ios":\#(lastBuild(status: "failed"))}"#
    let never = try workspace(#""ios":\#(stopped),\#(failed),"builds":{"ios":[\#(entry("failed"))]}"#)
    #expect(never.appPresence(never.devices[0]) == AppPresence.none)
    let once = try workspace(
      #""ios":\#(stopped),\#(failed),"builds":{"ios":[\#(entry("failed")),\#(entry("succeeded"))]}"#)
    #expect(once.appPresence(once.devices[0]) == .closed)
  }

  @Test func assumesAPlatformWithNoHistoryBuiltBefore() throws {
    let env = try workspace(
      #""ios":\#(booted),"app":{"id":"a","state":"stopped"}},"lastBuilds":{"ios":\#(lastBuild(status: "failed"))},"builds":{"android":[]}"#
    )
    #expect(env.appPresence(env.devices[0]) == .closed)
  }

  @Test func doesNotGuessFromAMissingAppWhichStatusOmitsWithoutABundleID() throws {
    let env = try workspace(#""ios":\#(booted)},"lastBuilds":{"ios":\#(lastBuild(status: "failed"))}"#)
    #expect(env.appPresence(env.devices[0]) == nil)
  }

  @Test func neverReportsTheAppOfALeasedPhone() throws {
    let env = try workspace(
      #""physicalDevices":[{"platform":"ios","slot":"default","id":"U","name":"Phone","connection":"connected","lease":{"holder":"h","kind":"run","expiresAt":"\#(iso(-600))"}}],"lastBuilds":{"ios":\#(lastBuild(status: "failed"))},"builds":{"ios":[\#(entry("failed"))]}"#
    )
    #expect(env.appPresence(env.devices[0]) == nil)
  }
}

@Suite struct FinishedRunsStampTests {
  @Test func changesWhenEitherPlatformFinishesARun() throws {
    let none = try workspace("")
    let first = try workspace(#""lastBuilds":{"ios":\#(lastBuild(finishedAgo: 60))}"#)
    let second = try workspace(#""lastBuilds":{"ios":\#(lastBuild(finishedAgo: 10))}"#)
    let android = try workspace(#""lastBuilds":{"ios":\#(lastBuild(finishedAgo: 10)),"android":\#(lastBuild("android"))}"#)
    #expect(Set([none, first, second, android].map(\.finishedRunsStamp)).count == 4)
  }
}

@Suite struct WorkspaceUsageTests {
  let machine = MachineUsage(owners: [
    MachineOwner(kind: .simulator, name: "s", workspace: "/w", id: "SIM-1", owned: true, cpuPercent: 9, memoryMb: 2150),
    MachineOwner(kind: .emulator, name: "e", workspace: "/w", id: "stim-w", owned: true, cpuPercent: 14, memoryMb: 2970),
    MachineOwner(kind: .metro, name: "m", workspace: "/w", id: "8084", owned: true, cpuPercent: 250, memoryMb: 1434),
    MachineOwner(kind: .emulator, name: "x", workspace: "/other", id: "stim-x", owned: true, cpuPercent: 99, memoryMb: 1),
  ])

  func env() throws -> Workspace {
    try workspace(
      #""ios":\#(booted)},"android":{"name":"stim-w","owned":true,"physical":false,"serial":"emulator-5554","state":"detected","disk":{"bytes":5100000000}}"#
    )
  }

  @Test func sumsTheWorkspaceOwnersPastOneCore() throws {
    #expect(try env().usage(machine: machine) == WorkspaceUsage(cpuPercent: 273, memoryMb: 6554))
  }

  @Test func fillsFromASampleOnlyWhatStatusLeftEmptyAndIgnoresSampledResidentSize() {
    let empty = WorkspaceUsage()
    #expect(empty.filling(cpuPercent: 12, footprintMb: nil) == WorkspaceUsage(cpuPercent: 12))
    #expect(empty.filling(cpuPercent: nil, footprintMb: 2100) == WorkspaceUsage(memoryMb: 2100))
    let reported = WorkspaceUsage(cpuPercent: 3, memoryMb: 2200)
    #expect(reported.filling(cpuPercent: 40, footprintMb: 32_000) == reported)
  }

  @Test func matchesAnEmulatorBySlotAndKindSinceItsOwnerIDIsTheAVDName() throws {
    let env = try env()
    let android = env.devices.first { $0.platform == "android" }!
    #expect(env.usage(of: android, machine: machine) == WorkspaceUsage(cpuPercent: 14, memoryMb: 2970, diskBytes: 5.1e9))
  }

  @Test func listsDevicesBeforeMetroInTheProcessTable() throws {
    #expect(
      try env().processRows(machine: machine).map(\.label) == ["iPhone 18 simulator", "Android emulator", "Metro"])
  }

  @Test func addsTheWorktreeAndBuildFoldersForDisk() throws {
    let env = try workspace(#""disk":{"worktreeBytes":1900000000,"nodeModulesBytes":900000000,"buildBytes":300000000}"#)
    #expect(env.usage(machine: nil).diskBytes == 2.2e9)
  }

  @Test func splitsNodeModulesOutOfTheWorktreeSoTheDiskPartsAddUpToTheTotal() throws {
    let env = try workspace(#""disk":{"worktreeBytes":1720000000,"nodeModulesBytes":1530000000,"buildBytes":19200000}"#)
    let breakdown = try #require(env.diskBreakdown)
    #expect(breakdown.parts.map(\.kind) == [.nodeModules, .worktree, .build])
    #expect(breakdown.parts.map(breakdown.label(of:)) == ["node_modules", "Rest of worktree", "Build output"])
    #expect(breakdown.total == env.diskBytes)
  }

  @Test func namesTheWholeWorktreeWhenNodeModulesIsUnmeasuredAndOmitsAnUnmeasuredBuild() throws {
    let env = try workspace(#""disk":{"worktreeBytes":500000000}"#)
    let breakdown = try #require(env.diskBreakdown)
    #expect(breakdown.parts.map(breakdown.label(of:)) == ["Worktree"])
    #expect(try workspace(#""disk":{"measuredAt":"x"}"#).diskBreakdown == nil)
  }

  @Test func keepsTenMinutesOfEachWorkspaceAndDropsOneThatStopped() {
    var history = OwnerHistory()
    for minute in 0...12 { history.append(machine, at: now.addingTimeInterval(Double(minute) * 60)) }
    #expect(history.cpu("/w").count == 10)
    #expect(history.memoryMb("/w").last == 6554)
    #expect(history.span("/w").map { $0.rounded() } == 540)
    history.append(MachineUsage(owners: [machine.owners[3]]), at: now.addingTimeInterval(13 * 60))
    #expect(history.cpu("/w").isEmpty)
    #expect(history.cpu("/other").count == 10)
  }
}

@Suite struct DeviceOrderTests {
  @Test func ordersByPlatformThenPhysicalThenRemoteAndKeepsPlacesWhenAnAgentDrives() throws {
    let tablet = #"{"slot":"tablet","android":{"name":"stim-w-tab","owned":true,"physical":false,"state":"detected"}}"#
    let old = #"{"slot":"old","ios":{"name":"stim-w-old (iPhone 15 26.0)","udid":"OLD","owned":true,"state":"Shutdown"}}"#
    let rest =
      #""web":{"running":true,"url":"http://localhost:8081","headless":false,"viewport":"desktop","profile":"p"},"physicalDevices":[{"platform":"android","slot":"default","id":"R5","connection":"connected","lease":{"holder":"h","kind":"run","expiresAt":"\#(iso(-600))"}}],"remoteDevices":[{"platform":"ios","backend":"eas","sessionId":"S","state":"claimed"}]"#
    let idle = try workspace(#""ios":\#(booted)},"slots":[\#(tablet),\#(old)],\#(rest)"#)
    let drivenTablet = tablet.replacingOccurrences(
      of: #""detected"}"#, with: #""detected","activity":{"state":"driven","basis":[]}}"#)
    let driven = try workspace(#""ios":\#(booted)},"slots":[\#(drivenTablet),\#(old)],\#(rest)"#)
    let order = [
      "ios:SIM-1", "android:tablet:stim-w-tab", "web:p", "android:default:physical:R5", "remote:S", "ios:OLD",
    ]
    #expect(idle.orderedDevices.map(\.id) == order)
    #expect(driven.orderedDevices.map(\.id) == order)
  }
}

@Suite struct PhaseStepTests {
  let history = try! JSONDecoder().decode(
    [BuildHistoryEntry].self,
    from: Data(
      ("[" + String(lastBuild(cacheHit: "false").dropLast())
        + #","result":"succeeded","slot":"default","phases":{"prepare":2000,"prebuild":4000,"pods":21000,"compile":94000,"install":8000}}]"#)
        .utf8))

  func build(_ extra: String = "") throws -> Build {
    try JSONDecoder().decode(Build.self, from: Data(runningBuild(extra).utf8))
  }

  @Test func marksEarlierPhasesDoneAndLaterOnesPendingWithReferenceTimes() throws {
    let steps = try build().phaseSteps(history: history, now: now)
    #expect(steps.map(\.phase) == ["prepare", "prebuild", "pods", "compile", "install"])
    #expect(steps.map(\.state) == [.done, .done, .done, .current, .pending])
    #expect(steps[3].elapsedMs == 47_000)
    #expect(steps[3].fraction == 0.5)
    #expect(steps[4].expectedMs == 8000)
  }

  @Test func foldsTheShortPreparePhasesIntoOneBarSegment() throws {
    var early = try build()
    early.phase = "cache-lookup"
    early.phaseStartedAt = iso(0)
    #expect(
      barSteps(early.phaseSteps(history: history, now: now)).map(\.phase) == [
        "prepare", "prebuild", "pods", "compile", "install",
      ])
    #expect(barSteps(early.phaseSteps(history: history, now: now)).first?.state == .current)
    var lookup = try build()
    lookup.phase = "cache-lookup"
    lookup.phaseStartedAt = iso(0)
    lookup.expectedPhaseMs = 1000
    let prepare = barSteps(lookup.phaseSteps(history: history, now: now))[0]
    #expect(prepare.expectedMs == 3000)
    #expect(prepare.fraction == 2000.0 / 3000.0)
  }

  @Test func givesTheDeviceWaitItsOwnBarSegment() throws {
    let withDevice = try JSONDecoder().decode(
      [BuildHistoryEntry].self,
      from: Data(
        ("[" + String(lastBuild(cacheHit: "false").dropLast())
          + #","result":"succeeded","slot":"default","phases":{"prepare":2000,"device":500,"compile":94000,"install":8000}}]"#)
          .utf8))
    var waiting = try build()
    waiting.phase = "device"
    waiting.phaseStartedAt = iso(0)
    let bar = barSteps(waiting.phaseSteps(history: withDevice, now: now))
    #expect(bar.map(\.phase) == ["prepare", "compile", "device", "install"])
    #expect(bar.map(\.state) == [.done, .done, .current, .pending])
  }

  @Test func namesPhasesOnlyWhenThereIsMoreThanOne() throws {
    var fresh = try build()
    fresh.phase = "prepare"
    fresh.phaseStartedAt = iso(0)
    let steps = fresh.phaseSteps(history: [], now: now)
    #expect(steps.map(\.phase) == ["prepare"])
    #expect(!namesPhases(steps))
    #expect(!namesPhases(barSteps(steps)))
    #expect(namesPhases(try build().phaseSteps(history: history, now: now)))
  }

  @Test func movesTheCompilePhaseByTheBuildToolCountsOnlyWhenTheyAreAheadOfTheTimeEstimate() throws {
    let detail = #","detail":{"step":"compile","unit":"targets","done":45,"total":180}"#
    let counted = try build(detail)
    #expect(counted.phaseSteps(history: history, now: now)[3].fraction == 0.5)
    #expect(
      try build(detail.replacingOccurrences(of: "45", with: "135")).phaseSteps(history: history, now: now)[3].fraction == 0.75)
    #expect(try build(detail.replacingOccurrences(of: "45", with: "0")).phaseSteps(history: history, now: now)[3].fraction == 0.5)
    #expect(counted.currentPhaseLabel == ("Compiling", "45 of 180 targets"))
    let tasks = try build(#","detail":{"step":"compile","unit":"tasks","done":45}"#)
    #expect(tasks.currentPhaseLabel.counts == "45 tasks")
    var signing = try build(detail.replacingOccurrences(of: #""step":"compile""#, with: #""step":"sign""#))
    signing.phase = "install"
    #expect(signing.currentPhaseLabel == ("Install", nil))
  }

  @Test func drawsTheCLIPlannedPhasesInsteadOfTheWorkspaceHistoryWhenTheCLISendsThem() throws {
    var planned = try build(
      #","plannedPhases":[{"phase":"prepare","expectedMs":1500},{"phase":"cache-lookup","expectedMs":2000},{"phase":"device","expectedMs":800},{"phase":"install","expectedMs":500},{"phase":"launch","expectedMs":9000}]"#
    )
    planned.phase = "cache-lookup"
    planned.phaseStartedAt = iso(1)
    planned.outcome = "hit"
    planned.expectedPhaseMs = 2000
    let bar = barSteps(planned.phaseSteps(history: [], now: now))
    #expect(bar.map(\.phase) == ["prepare", "device", "install"])
    #expect(bar.map(\.state) == [.current, .pending, .pending])
    #expect(
      planned.phaseSteps(history: history, now: now).map(\.phase) == ["prepare", "cache-lookup", "device", "install", "launch"])
  }
}

@Suite struct BarFillsTests {
  func step(_ phase: String, _ state: PhaseStep.State, _ expectedMs: Double, _ fraction: Double) -> PhaseStep {
    PhaseStep(phase: phase, state: state, elapsedMs: nil, expectedMs: expectedMs, fraction: fraction)
  }

  @Test func fillsDoneSegmentsPartOfTheCurrentOneAndNoneOfThePendingOnes() {
    let fills = barFills(
      [step("prepare", .done, 4000, 1), step("compile", .current, 8000, 0.5), step("install", .pending, 8000, 0)],
      key: "fills-plain")
    #expect(fills == [1, 0.5, 0])
    #expect(barFills([], key: "fills-empty") == [])
  }

  @Test func neverFillsAPendingSegmentWhenNoPhaseIsCurrent() {
    let key = "fills-no-current"
    _ = barFills([step("prepare", .done, 4000, 1), step("install", .current, 6000, 0.9)], key: key)
    #expect(barFills([step("prepare", .done, 4000, 1), step("install", .pending, 6000, 0)], key: key) == [1, 0])
  }

  @Test func keepsWhatItDrewForTheSameBuildWhenThePlanChangesUpToTheEndOfTheCurrentSegment() {
    let key = "fills-replan"
    let round = { (fills: [Double]) in fills.map { ($0 * 100).rounded() / 100 } }
    #expect(barFills([step("prepare", .current, 4000, 0.9), step("install", .pending, 6000, 0)], key: key) == [0.9, 0])
    #expect(round(barFills([step("prepare", .current, 4000, 0.2), step("install", .pending, 6000, 0)], key: key)) == [0.9, 0])
    let coldPlan = [
      step("prepare", .done, 4000, 1), step("pods", .current, 10_000, 0.02), step("compile", .pending, 60_000, 0),
      step("install", .pending, 6000, 0),
    ]
    #expect(round(barFills(coldPlan, key: key)) == [1, 0.95, 0, 0])
    #expect(abs(barFills(coldPlan, key: "fills-other-build")[1] - 0.02) < 1e-5)
  }
}

@Suite struct BundleLineTests {
  func env(_ bundle: String?) throws -> Workspace {
    try workspace(#""metro":{"port":8084,"running":true,"pid":1\#(bundle.map { #","bundle":\#($0)"# } ?? "")}"#)
  }

  @Test func showsBundlingTheLastBundleOrThatNoneRanYet() throws {
    #expect(
      try env(#"{"bundling":true,"percent":62.4}"#).bundleLine(now: now, reportsBundles: true)?.text == "Bundling \u{00B7} 62%")
    #expect(
      try env(#"{"bundling":false,"last":{"platform":"ios","status":"ok","durationMs":1800,"finishedAt":"\#(iso(12))"}}"#)
        .bundleLine(now: now, reportsBundles: true)?.text == "Bundled in 1.8s \u{00B7} 12s ago")
    #expect(try env(nil).bundleLine(now: now, reportsBundles: true)?.text == "Not bundled yet")
    #expect(try env(nil).bundleLine(now: now, reportsBundles: false) == nil)
  }
}

@Suite struct AgentRowTests {
  @Test func namesTheDrivingToolWithItsLastActionOrHowLongTheDeviceIsIdle() throws {
    let driven = try JSONDecoder().decode(
      DeviceActivity.self,
      from: Data(#"{"state":"driven","driver":{"tool":"agent-device","since":"\#(iso(18 * 60))"},"basis":[]}"#.utf8))
    let row = AgentRow(activity: driven, last: (now.addingTimeInterval(-12), "Tapped \"Allow camera\""), now: now)
    #expect(row.tool == "agent-device")
    #expect(row.text == "Tapped \"Allow camera\" \u{00B7} 12s ago")
    let idle = try JSONDecoder().decode(
      DeviceActivity.self, from: Data(#"{"state":"idle","lastActivityAt":"\#(iso(360))","basis":[]}"#.utf8))
    let quiet = AgentRow(activity: idle, last: nil, now: now)
    #expect(quiet.tool == nil)
    #expect(quiet.text == "idle 6m")
  }
}

@Suite struct GitChipTests {
  func worktree(_ git: String = "", pullRequest: String? = nil) throws -> WorktreeInfo {
    var fields: [String: Any] = ["changed": 0, "untracked": 0, "upstream": "origin/x", "ahead": 0, "behind": 0]
    let patch = try JSONSerialization.jsonObject(with: Data("{\(git.drop { $0 == "," })}".utf8)) as! [String: Any]
    fields.merge(patch) { _, new in new }
    var object: [String: Any] = ["path": "/w", "git": fields]
    if let pullRequest {
      object["pullRequest"] = try JSONSerialization.jsonObject(with: Data(pullRequest.utf8), options: .fragmentsAllowed)
    }
    return try JSONDecoder().decode(WorktreeInfo.self, from: JSONSerialization.data(withJSONObject: object))
  }

  @Test func showsGitDetailsOnlyWhenThereAreSome() throws {
    #expect(try GitChip(worktree(#","ahead":2,"changed":2,"untracked":1"#))?.parts.map(\.text) == ["\u{2191}2", "3 changed"])
    #expect(try GitChip(worktree(#","mergedInto":"main""#))?.parts.map(\.text) == ["merged into main"])
    #expect(try GitChip(worktree(#","upstream":null,"ahead":null,"behind":null"#))?.parts.map(\.text) == ["no upstream"])
    #expect(try GitChip(worktree())?.parts == [])
    #expect(GitChip(WorktreeInfo(path: "/w")) == nil)
  }

  @Test func coloursThePullRequestByStateWithOneCIMarkForTheWorstCheck() throws {
    let pr =
      #"{"number":1695,"url":"https://github.com/o/r/pull/1695","title":"t","state":"open","checks":{"passing":12,"failing":1,"pending":2}}"#
    let open = try GitChip(worktree(pullRequest: pr))
    #expect(open?.pullRequest?.text == "PR #1695")
    #expect(open?.pullRequest?.tone == .success)
    #expect(open?.pullRequest?.checks == .failing)
    #expect(open?.label == "Pull request 1695, open, checks failing")
    let merged = try GitChip(
      worktree(#","mergedInto":"main""#, pullRequest: pr.replacingOccurrences(of: "\"open\"", with: "\"merged\"")))
    #expect(merged?.pullRequest?.tone == .brand)
    #expect(merged?.parts == [])
    #expect(try GitChip(worktree())?.label == "Branch, up to date")
    #expect(try GitChip(worktree(pullRequest: "null"))?.pullRequest == nil)
  }
}

@Suite struct OffloadedBuildTests {
  @Test func namesTheBuildMachineWithoutItsPortAndTheStepItRunsThere() throws {
    let placement =
      #","placement":{"host":"janics-mac-mini:7869","phase":"pods","startedAt":"\#(iso(90))","phaseStartedAt":"\#(iso(56))"}"#
    let build = try #require(try workspace(#""build":\#(runningBuild(placement))"#).build)
    #expect(build.remote(at: now) == RemoteBuild(host: "janics-mac-mini", phase: "Pods", phaseElapsedMs: 56_000))
    #expect(build.currentPhaseLabel.phase == "Pods")
    let local = try #require(try workspace(#""build":\#(runningBuild(#","placement":"local""#))"#).build)
    #expect(local.remote(at: now) == nil && local.currentPhaseLabel.phase == "Compile")
    #expect(machineName("mini") == "mini" && machineName("Mini.tail1.ts.net:7443") == "Mini.tail1.ts.net")
  }

  @Test func marksOffloadedRunsAndShortensTheFallbackReasonsStimRecords() throws {
    let offloaded = try #require(
      try workspace(
        #""lastBuilds":{"ios":\#(lastBuild(cacheHit: "false", durationMs: 71_000).dropLast()),"offloadedTo":"janics-mac-mini:7869"}}"#
      )
      .lastBuilds?.ios)
    #expect(offloaded.summary == "Built on janics-mac-mini in 1m 11s")
    let cases: [(String, String)] = [
      ("janics-mac-mini: busy (load at or above 2/core; load 8.2/core, 2 builds)", "janics-mac-mini busy \u{2192} built here"),
      (
        "mini:7869: Stim build 6bbe there, e774 here; busy (already running 1 offloaded build(s), its limit)",
        "mini on another Stim build \u{2192} built here"
      ),
      ("mini: no less loaded (load 1.2/core there, 0.4/core here); box: no offer", "mini no less loaded \u{2192} built here"),
      ("mini: capacity unknown (older stim-server) while this Mac has a free slot", "mini too old \u{2192} built here"),
      ("mini: no iPhone simulator on 27.0 there", "mini missing SDK \u{2192} built here"),
      ("mini: 4.1 GB free, needs 10.0 GB", "mini low on disk \u{2192} built here"),
      ("mini: Stim build 6bbe there, e774 here; 4.1 GB free, needs 10.0 GB", "mini on another Stim build \u{2192} built here"),
      ("mini: the connection closed (1006)", "mini failed \u{2192} built here"),
      ("this app is not in a git checkout (fatal: not a git repository)", "offload skipped \u{2192} built here"),
    ]
    for (reason, text) in cases {
      var build = offloaded
      build.offloadFallback = reason
      #expect(build.fallbackLine?.text == text && build.fallbackLine?.reason == reason)
    }
  }
}

/// Replays the cases `apps/mobile/src/lib/workspace-view.test.ts` also replays, so both apps word a workspace the same.
@Suite struct WorkspaceViewVectorTests {
  struct Vectors: Decodable {
    struct Stage: Decodable {
      var label: String
      var tone: String
      var subtitle: String?
    }

    struct StageCase: Decodable {
      var name: String
      var workspace: Workspace
      var stage: Stage
    }

    struct Part: Decodable, Equatable {
      var text: String
      var tone: String
    }

    struct ChipPullRequest: Decodable, Equatable {
      var text: String
      var tone: String
      var checks: String?
    }

    struct Chip: Decodable {
      var parts: [Part]
      var pullRequest: ChipPullRequest?
      var label: String
    }

    struct ChipCase: Decodable {
      var name: String
      var worktree: WorktreeInfo
      var chip: Chip
    }

    struct ChecksCase: Decodable {
      var name: String
      var checks: PullRequestFacts.Checks?
      var summary: String?
    }

    struct Step: Decodable, Equatable {
      var phase: String
      var name: String
      var state: String
      var elapsedMs: Double?
      var expectedMs: Double?
      var fraction: Double?
    }

    struct PhaseCase: Decodable {
      var name: String
      var build: Build
      var history: [BuildHistoryEntry]
      var steps: [Step]
      var bars: [Step]
      var namesPhases: Bool
    }

    struct BadgeCase: Decodable {
      var name: String
      var activity: DeviceActivity
      var text: String?
    }

    struct DriversCase: Decodable {
      var name: String
      var activities: [DeviceActivity?]
      var summary: String?
    }

    struct Activity: Decodable {
      var badge: [BadgeCase]
      var drivers: [DriversCase]
    }

    struct Line: Decodable, Equatable {
      var text: String
      var tone: String
    }

    struct BundleCase: Decodable {
      var name: String
      var workspace: Workspace
      var reportsBundles: Bool
      var line: Line?
    }

    struct LastAction: Decodable {
      var agoMs: Double
      var message: String
    }

    struct Row: Decodable, Equatable {
      var tool: String?
      var text: String
    }

    struct RowCase: Decodable {
      var name: String
      var activity: DeviceActivity
      var last: LastAction?
      var row: Row
    }

    var now: String
    var stage: [StageCase]
    var gitChip: [ChipCase]
    var checksSummary: [ChecksCase]
    var phases: [PhaseCase]
    var activity: Activity
    var bundleLine: [BundleCase]
    var agentRow: [RowCase]
  }

  static let vectors: Vectors = {
    let url = Bundle.module.url(forResource: "workspace-view-vectors", withExtension: "json", subdirectory: "Fixtures")!
    return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }()

  static let now = parseTimestamp(vectors.now)!

  @Test(arguments: vectors.stage.map(\.name))
  func wordsTheStageAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.stage.first { $0.name == name })
    let stage = c.workspace.stage(now: Self.now)
    #expect(stage.label.rawValue == c.stage.label)
    #expect(String(describing: stage.tone) == c.stage.tone)
    #expect(stage.subtitle == c.stage.subtitle)
  }

  @Test(arguments: vectors.gitChip.map(\.name))
  func wordsTheGitChipAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.gitChip.first { $0.name == name })
    let chip = try #require(GitChip(c.worktree))
    #expect(chip.parts.map { Vectors.Part(text: $0.text, tone: String(describing: $0.tone)) } == c.chip.parts)
    #expect(
      chip.pullRequest.map {
        Vectors.ChipPullRequest(
          text: $0.text, tone: String(describing: $0.tone), checks: $0.checks.map { String(describing: $0) })
      } == c.chip.pullRequest)
    #expect(chip.label == c.chip.label)
  }

  @Test(arguments: vectors.checksSummary.map(\.name))
  func summarizesChecksAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.checksSummary.first { $0.name == name })
    #expect(GitChip.checksSummary(c.checks) == c.summary)
  }

  @Test(arguments: vectors.phases.map(\.name))
  func stepsThroughPhasesAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.phases.first { $0.name == name })
    let steps = c.build.phaseSteps(history: c.history, now: Self.now)
    func plain(_ steps: [PhaseStep], elapsed: Bool) -> [Vectors.Step] {
      steps.map {
        Vectors.Step(
          phase: $0.phase, name: PhaseStep.name($0.phase), state: String(describing: $0.state),
          elapsedMs: elapsed ? $0.elapsedMs : nil, expectedMs: $0.expectedMs, fraction: $0.fraction)
      }
    }
    expectClose(plain(steps, elapsed: true), c.steps)
    expectClose(plain(barSteps(steps), elapsed: false), c.bars)
    #expect(namesPhases(steps) == c.namesPhases)
  }

  @Test(arguments: vectors.activity.badge.map(\.name))
  func wordsTheActivityBadgeAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.activity.badge.first { $0.name == name })
    #expect(ActivityBadge(c.activity, now: Self.now)?.text == c.text)
  }

  @Test(arguments: vectors.activity.drivers.map(\.name))
  func summarizesDriversAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.activity.drivers.first { $0.name == name })
    #expect(ActivityBadge.driversSummary(c.activities, now: Self.now) == c.summary)
  }

  @Test(arguments: vectors.bundleLine.map(\.name))
  func wordsTheBundleLineAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.bundleLine.first { $0.name == name })
    let line = c.workspace.bundleLine(now: Self.now, reportsBundles: c.reportsBundles)
    #expect(line.map { Vectors.Line(text: $0.text, tone: String(describing: $0.tone)) } == c.line)
  }

  @Test(arguments: vectors.agentRow.map(\.name))
  func wordsTheAgentRowAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.agentRow.first { $0.name == name })
    let last = c.last.map { (date: Self.now.addingTimeInterval(-$0.agoMs / 1000), message: $0.message) }
    let row = AgentRow(activity: c.activity, last: last, now: Self.now)
    #expect(Vectors.Row(tool: row.tool, text: row.text) == c.row)
  }
}

private func expectClose(_ actual: [WorkspaceViewVectorTests.Vectors.Step], _ expected: [WorkspaceViewVectorTests.Vectors.Step]) {
  #expect(actual.count == expected.count)
  for (a, e) in zip(actual, expected) {
    #expect(a.phase == e.phase && a.name == e.name && a.state == e.state)
    #expect(a.elapsedMs == e.elapsedMs && a.expectedMs == e.expectedMs)
    #expect(a.fraction == nil ? e.fraction == nil : abs(a.fraction! - (e.fraction ?? .infinity)) < 1e-9)
  }
}
