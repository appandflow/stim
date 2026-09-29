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

  @Test func takesProgressFromTheBuildToolCounts() throws {
    let counted = try build(#","detail":{"step":"compile","unit":"targets","done":45,"total":180}"#)
    #expect(counted.phaseSteps(history: history, now: now)[3].fraction == 0.25)
    #expect(counted.currentPhaseLabel == ("Compiling", "45 of 180 targets"))
    let tasks = try build(#","detail":{"step":"compile","unit":"tasks","done":45}"#)
    #expect(tasks.currentPhaseLabel.counts == "45 tasks")
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
