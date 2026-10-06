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
  @Test func listsClosedAppsInSidebarOrderWhicheverOrderStimReports() throws {
    let stopped = #"\#(booted),"app":{"id":"a","state":"stopped"}"#
    let android = #"{"name":"stim-w","owned":true,"physical":false,"state":"detected","app":{"id":"a","state":"stopped"}}"#
    let local = try workspace(#""android":\#(android),"slots":[{"slot":"b","ios":\#(stopped)}}]"#)
    var reported = local
    reported.stageFacts = StageFacts(
      kind: "running", since: nil, platform: nil,
      closedApps: [.init(platform: "android", slot: "default"), .init(platform: "ios", slot: "b")])
    let expected = WorkspaceStage(
      label: .running, tone: .error, subtitle: "iOS app closed \u{00B7} Android app closed")
    #expect(local.stage(now: now) == expected)
    #expect(reported.stage(now: now) == expected)
  }

  @Test func derivesTheStageItselfWhenStimReportsAKindItDoesNotKnow() throws {
    let env = try workspace(
      #""supervisor":{"startedAt":"\#(iso(42 * 60))","healthy":true},"stage":{"kind":"paused","since":null,"platform":null,"closedApps":[]}"#
    )
    #expect(env.stage(now: now) == WorkspaceStage(label: .running, tone: .success, subtitle: "up 42m"))
  }

}

@Suite struct AppPresenceTests {
  @Test func readsThePresenceStimReportsOnceItReportsTheStage() throws {
    let stage = #""stage":{"kind":"running","since":null,"platform":null,"closedApps":[]}"#
    let reported = try workspace(#""ios":\#(booted),"app":{"id":"a","state":"stopped"},"appPresence":"none"},\#(stage)"#)
    #expect(reported.appPresence(reported.devices[0]) == AppPresence.none)
    let cleared = try workspace(#""ios":\#(booted),"app":{"id":"a","state":"stopped"},"appPresence":null},\#(stage)"#)
    #expect(cleared.appPresence(cleared.devices[0]) == nil)
  }

  private func entry(_ result: String) -> String {
    String(lastBuild().dropLast()) + #","result":"\#(result)","slot":"default","phases":{}}"#
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
    #expect(try #require(env.diskBreakdown).total == 2.2e9)
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

  @Test func showsTheTimeEachCompletedPhaseTookWhenTheCLISendsIt() throws {
    let steps = try build(#","completedPhaseMs":{"prepare":1800,"pods":15000}"#).phaseSteps(history: history, now: now)
    #expect(steps.map(\.elapsedMs) == [1800, nil, 15_000, 47_000, nil])
    #expect(try build().phaseSteps(history: history, now: now).map(\.elapsedMs) == [nil, nil, nil, 47_000, nil])
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
    #expect(
      planned.phaseSteps(history: history, now: now).map(\.phase) == ["prepare", "cache-lookup", "device", "install", "launch"])
  }
}

@Suite struct BarFillsStateTests {
  func current(_ fraction: Double) -> PhaseStep {
    PhaseStep(phase: "compile", state: .current, elapsedMs: nil, expectedMs: 1000, fraction: fraction)
  }

  @Test func remembersProgressWithinABuildWithoutCarryingItIntoAnotherBuild() {
    let first = barFills([current(0.8)], key: "prune-progress")[0]
    #expect(barFills([current(0.2)], key: "prune-progress")[0] >= first)
    #expect(barFills([current(0.2)], key: "prune-other-build")[0] < first)
  }

  @Test func doesNotCreditAPendingPhaseWithRememberedProgress() {
    _ = barFills([current(0.8)], key: "prune-pending")
    let pending = PhaseStep(phase: "compile", state: .pending, elapsedMs: nil, expectedMs: 1000, fraction: 0)
    #expect(barFills([pending], key: "prune-pending")[0] == 0)
  }
}

@Suite struct GitChipTests {
  @Test func omitsTheChipWhenStatusHasNoGitData() {
    #expect(GitChip(WorktreeInfo(path: "/w")) == nil)
  }

  @Test func doesNotInventAPullRequestForAnExplicitNull() throws {
    let worktree = try JSONDecoder().decode(
      WorktreeInfo.self,
      from: Data(
        #"{"path":"/w","git":{"changed":0,"untracked":0,"upstream":"origin/x","ahead":0,"behind":0},"pullRequest":null}"#
          .utf8))
    let chip = try #require(GitChip(worktree))
    #expect(chip.pullRequest == nil)
  }
}

@Suite struct WaitingBuildTests {
  @Test func readsTheWorkspaceWhoseBuildItWaitsFor() throws {
    let waiting = #","waitingOn":{"path":"/w/app-a"}"#
    let build = try #require(try workspace(#""build":\#(runningBuild(waiting))"#).build)
    #expect(build.waitingOn == WaitingOn(path: "/w/app-a"))
    #expect(try #require(try workspace(#""build":\#(runningBuild())"#).build).waitingOn == nil)
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
      var derived: StageFacts
      var stage: Stage
    }

    struct PresenceCase: Decodable {
      var name: String
      var workspace: Workspace
      var platform: String
      var slot: String
      var presence: String?
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
      var derived: GitChipFacts
      var chip: Chip
    }

    struct Step: Decodable, Equatable {
      var phase: String
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

    struct DiskPart: Decodable, Equatable {
      var kind: String
      var bytes: Double
    }

    struct DiskCase: Decodable {
      var name: String
      var workspace: Workspace
      var parts: [DiskPart]?
    }

    var now: String
    var stage: [StageCase]
    var gitChip: [ChipCase]
    var appPresence: [PresenceCase]
    var phases: [PhaseCase]
    var activity: Activity
    var bundleLine: [BundleCase]
    var diskParts: [DiskCase]
  }

  static let vectors: Vectors = {
    let url = Bundle.module.url(forResource: "workspace-view-vectors", withExtension: "json", subdirectory: "Fixtures")!
    return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }()

  static let now = parseTimestamp(vectors.now)!

  @Test(arguments: vectors.stage.map(\.name))
  func wordsTheStageAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.stage.first { $0.name == name })
    #expect(c.workspace.localStageFacts() == c.derived)
    var reported = c.workspace
    reported.stageFacts = c.derived
    for env in [c.workspace, reported] {
      let stage = env.stage(now: Self.now)
      #expect(stage.label.rawValue == c.stage.label)
      #expect(String(describing: stage.tone) == c.stage.tone)
      #expect(stage.subtitle == c.stage.subtitle)
    }
  }

  @Test(arguments: vectors.gitChip.map(\.name))
  func wordsTheGitChipAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.gitChip.first { $0.name == name })
    #expect(GitChip.localFacts(try #require(c.worktree.git), c.worktree.pullRequest) == c.derived)
    var reported = c.worktree
    reported.gitChip = c.derived
    for worktree in [c.worktree, reported] {
      let chip = try #require(GitChip(worktree))
      #expect(chip.parts.map { Vectors.Part(text: $0.text, tone: String(describing: $0.tone)) } == c.chip.parts)
      #expect(
        chip.pullRequest.map {
          Vectors.ChipPullRequest(
            text: $0.text, tone: String(describing: $0.tone), checks: $0.checks.map { String(describing: $0) })
        } == c.chip.pullRequest)
      #expect(chip.label == c.chip.label)
    }
  }

  @Test(arguments: vectors.appPresence.map(\.name))
  func judgesAppPresenceAsStimDoes(name: String) throws {
    let c = try #require(Self.vectors.appPresence.first { $0.name == name })
    let device = try #require(c.workspace.devices.first { $0.platform == c.platform && $0.slot == c.slot })
    #expect(c.workspace.appPresence(device).map { $0 == .none ? "none" : "closed" } == c.presence)
  }

  @Test(arguments: vectors.phases.map(\.name))
  func stepsThroughPhasesAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.phases.first { $0.name == name })
    let steps = c.build.phaseSteps(history: c.history, now: Self.now)
    let actual = steps.map {
      Vectors.Step(
        phase: $0.phase, state: String(describing: $0.state),
        elapsedMs: $0.elapsedMs, expectedMs: $0.expectedMs, fraction: $0.fraction)
    }
    expectClose(actual, c.steps)
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

  @Test(arguments: vectors.diskParts.map(\.name))
  func splitsTheDiskAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.diskParts.first { $0.name == name })
    let breakdown = c.workspace.diskBreakdown
    let parts = breakdown.map { b in
      b.parts.map { Vectors.DiskPart(kind: $0.kind.rawValue, bytes: $0.bytes) }
    }
    #expect(parts == c.parts)
  }
}

private func expectClose(_ actual: [WorkspaceViewVectorTests.Vectors.Step], _ expected: [WorkspaceViewVectorTests.Vectors.Step]) {
  #expect(actual.count == expected.count)
  for (a, e) in zip(actual, expected) {
    #expect(a.phase == e.phase && a.state == e.state)
    #expect(a.elapsedMs == e.elapsedMs && a.expectedMs == e.expectedMs)
    #expect(a.fraction == nil ? e.fraction == nil : abs(a.fraction! - (e.fraction ?? .infinity)) < 1e-9)
  }
}
