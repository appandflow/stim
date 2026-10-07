import Foundation
import Testing

@testable import StimKit

struct TipsTests {
  let now = Date(timeIntervalSince1970: 1_791_201_600)
  var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    return calendar
  }
  let mac = TailnetMac(id: "mini", hostName: "Mini", dnsName: "mini.tail.test")

  func workspace(_ path: String = "/one", live: Bool = false, fields: String = "") throws -> Workspace {
    try JSONDecoder().decode(
      Workspace.self, from: Data("{\"path\":\"\(path)\",\"live\":\(live),\"warnings\":[]\(fields)}".utf8))
  }

  var runningBuild: String {
    """
    ,"build":{"platform":"ios","slot":"default","state":"running","phase":"compile",
    "startedAt":"2026-10-05T12:00:00Z","phaseStartedAt":"2026-10-05T12:00:00Z","basis":0}
    """
  }

  func realUsage(days: Int = 3, workspaces: Int = 3, builds: Int = 0) -> UsageRecord {
    var usage = UsageRecord()
    usage.days = (0..<days).map { "2026-10-\(10 + $0)" }
    usage.workspaces = (0..<workspaces).map { "/\($0)" }
    usage.builds = (0..<builds).map { "/one|\($0)" }
    return usage
  }

  func withDefaults(_ body: (UserDefaults) throws -> Void) rethrows {
    let name = "TipsTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defer { defaults.removePersistentDomain(forName: name) }
    try body(defaults)
  }

  @Test func eachTopicRequiresItsOwnApplicableCondition() throws {
    var inputs = TipInputs()
    inputs.machines = []
    inputs.hosting = []
    inputs.macs = [mac]
    inputs.pairedPhones = 0
    inputs.phoneApp = true
    inputs.rows = 11
    inputs.workspaces = [try workspace(fields: ",\"recording\":{\"enabled\":true}")]
    for topic in TipTopic.allCases {
      #expect(Tips.applicable(topic, inputs: inputs))
      var negative = inputs
      switch topic {
      case .buildMachine: negative.machines = ["mini"]
      case .phone: negative.pairedPhones = 1
      case .tutorial: negative.tutorialCompleted = true
      case .hideWorkspaces: negative.sidebar.hiddenWorkspaces = HiddenWorkspaces(paths: ["/one"])
      case .statusFilter: negative.sidebar.statuses = [.live]
      case .replay: negative.workspaces = [try workspace(fields: ",\"recording\":{\"enabled\":false}")]
      case .hostedSimulators: negative.hosting = ["mini"]
      }
      #expect(!Tips.applicable(topic, inputs: negative))
    }
    inputs.rows = 10
    #expect(!Tips.applicable(.hideWorkspaces, inputs: inputs))
    inputs.pairedPhones = nil
    inputs.machines = nil
    inputs.hosting = nil
    #expect(!Tips.applicable(.phone, inputs: inputs))
    #expect(!Tips.applicable(.buildMachine, inputs: inputs))
    #expect(!Tips.applicable(.hostedSimulators, inputs: inputs))
    inputs.machines = []
    inputs.hosting = []
    for macs: [TailnetMac]? in [nil, []] {
      inputs.macs = macs
      #expect(!Tips.applicable(.buildMachine, inputs: inputs))
      #expect(!Tips.applicable(.hostedSimulators, inputs: inputs))
    }
    inputs.workspaces = [try workspace()]
    #expect(!Tips.applicable(.replay, inputs: inputs))
  }

  @Test func gateNeedsThreeDaysAndEitherThreeWorkspacesOrFiveBuilds() {
    func gate(_ usage: UsageRecord) -> Bool {
      Tips.gate(usage: usage, setupCompleted: true, workspaces: [], enabled: true)
    }
    #expect(!gate(realUsage(days: 2)))
    #expect(!gate(realUsage(workspaces: 2, builds: 4)))
    #expect(gate(realUsage(workspaces: 3, builds: 0)))
    #expect(gate(realUsage(workspaces: 0, builds: 5)))
    #expect(!gate(realUsage(days: 2, workspaces: 0, builds: 5)))
  }

  @Test func setupRunningBuildAndDisabledTipsEachBlockTheGate() throws {
    let usage = realUsage()
    #expect(!Tips.gate(usage: usage, setupCompleted: false, workspaces: [], enabled: true))
    #expect(!Tips.gate(usage: usage, setupCompleted: true, workspaces: [], enabled: false))
    let building = try workspace(fields: runningBuild)
    #expect(!Tips.gate(usage: usage, setupCompleted: true, workspaces: [building], enabled: true))
  }

  @Test func observationDeduplicatesDaysLivePathsAndBuildsAcrossPayloads() throws {
    let building = try workspace(live: true, fields: runningBuild)
    let last = try workspace(
      fields: """
        ,"lastBuilds":{"ios":{"platform":"ios","status":"ok","cacheHit":false,"startedAt":"2026-10-05T12:00:00Z"},
        "android":{"platform":"android","status":"ok","cacheHit":false,"startedAt":"2026-10-05T13:00:00Z"}},
        "builds":{"ios":[{"platform":"ios","status":"ok","cacheHit":false,"startedAt":"2026-10-05T11:00:00Z",
        "result":"succeeded","slot":"default","phases":{}}]}
        """)
    var usage = UsageRecord()
    usage.since = Date(timeIntervalSince1970: 0)
    usage.observe([building, last, try workspace("/idle")], now: now, calendar: calendar)
    let first = usage
    usage.observe([building, last], now: now.addingTimeInterval(60), calendar: calendar)
    #expect(usage == first)
    #expect(usage.workspaces == ["/one"])
    #expect(Set(usage.builds) == ["/one|2026-10-05T12:00:00Z", "/one|2026-10-05T13:00:00Z", "/one|2026-10-05T11:00:00Z"])
    usage.observe([], now: now.addingTimeInterval(86400), calendar: calendar)
    #expect(usage.days == ["2026-10-05", "2026-10-06"])
    var shifted = calendar
    shifted.timeZone = TimeZone(secondsFromGMT: 14 * 3600)!
    var local = UsageRecord()
    local.observe([], now: now, calendar: shifted)
    #expect(local.days == ["2026-10-06"])
  }

  @Test func observingNeverRewritesTheRecordOnceItsListsReachTheThresholds() throws {
    let entries = try (0..<12).map { try workspace("/\($0)", live: true, fields: runningBuild) }
    var usage = UsageRecord()
    usage.since = Date(timeIntervalSince1970: 0)
    usage.observe(entries, now: now, calendar: calendar)
    #expect(usage.workspaces.count == Tips.minRunningWorkspaces)
    #expect(usage.builds.count == Tips.minBuilds)
    let settled = usage
    for minute in 1...5 {
      usage.observe(entries, now: now.addingTimeInterval(Double(minute) * 60), calendar: calendar)
      #expect(usage == settled)
    }
  }

  @Test func buildsThatStartedBeforeTheFirstObservationDoNotCount() throws {
    let old = try workspace(live: false, fields: runningBuild)
    var usage = UsageRecord()
    usage.observe([old], now: now.addingTimeInterval(60), calendar: calendar)
    #expect(usage.since == now.addingTimeInterval(60))
    #expect(usage.builds.isEmpty)
  }

  @Test func usageKeepsOnlyTheLastThirtyDays() {
    var usage = UsageRecord()
    for index in 0..<45 {
      usage.observe([], now: now.addingTimeInterval(Double(index) * 86400), calendar: calendar)
    }
    #expect(usage.days.count == 30)
    #expect(usage.days.last == Tips.day(now.addingTimeInterval(44 * 86400), calendar: calendar))
  }

  @Test func selectionKeepsTheDailyTipAndRotatesToTheOldestTopicTomorrow() {
    var state = TipState()
    let inputs = TipInputs()
    #expect(Tips.select(inputs: inputs, state: &state, discoveries: [:], now: now, calendar: calendar) == .tutorial)
    let selected = state
    #expect(
      Tips.select(inputs: inputs, state: &state, discoveries: [:], now: now.addingTimeInterval(60), calendar: calendar)
        == .tutorial)
    #expect(state == selected)
    #expect(
      Tips.select(inputs: inputs, state: &state, discoveries: [:], now: now.addingTimeInterval(86400), calendar: calendar)
        == .statusFilter)
    #expect(
      Tips.select(inputs: inputs, state: &state, discoveries: [:], now: now.addingTimeInterval(2 * 86400), calendar: calendar)
        == .tutorial)
  }

  @Test func aTopicThatStopsApplyingIsReplacedDuringTheDay() {
    var state = TipState()
    var inputs = TipInputs()
    #expect(Tips.select(inputs: inputs, state: &state, discoveries: [:], now: now, calendar: calendar) == .tutorial)
    inputs.tutorialCompleted = true
    #expect(Tips.select(inputs: inputs, state: &state, discoveries: [:], now: now, calendar: calendar) == .statusFilter)
  }

  @Test func nextWrapsInCatalogOrderAndOneApplicableTipHasNoNext() {
    var state = TipState()
    var inputs = TipInputs()
    #expect(Tips.next(inputs: inputs, state: &state, discoveries: [:], now: now, calendar: calendar) == .tutorial)
    #expect(Tips.next(inputs: inputs, state: &state, discoveries: [:], now: now, calendar: calendar) == .statusFilter)
    #expect(Tips.next(inputs: inputs, state: &state, discoveries: [:], now: now, calendar: calendar) == .tutorial)
    inputs.sidebar.statuses = [.live]
    #expect(Tips.available(inputs: inputs, state: state, discoveries: [:], now: now, calendar: calendar) == [.tutorial])
    let before = state
    #expect(Tips.next(inputs: inputs, state: &state, discoveries: [:], now: now, calendar: calendar) == .tutorial)
    #expect(state == before)
    inputs.tutorialCompleted = true
    #expect(Tips.select(inputs: inputs, state: &state, discoveries: [:], now: now, calendar: calendar) == nil)
  }

  @Test func closingPersistsAndHidesOnlyForThatCalendarDay() {
    withDefaults { defaults in
      let store = TipStore(defaults: defaults)
      var state = store.state
      _ = Tips.select(inputs: TipInputs(), state: &state, discoveries: [:], now: now, calendar: calendar)
      store.state = state
      store.close(now: now, calendar: calendar)
      var reloaded = TipStore(defaults: defaults).state
      #expect(Tips.select(inputs: TipInputs(), state: &reloaded, discoveries: [:], now: now, calendar: calendar) == nil)
      #expect(Tips.next(inputs: TipInputs(), state: &reloaded, discoveries: [:], now: now, calendar: calendar) == nil)
      #expect(
        Tips.select(
          inputs: TipInputs(), state: &reloaded, discoveries: [:], now: now.addingTimeInterval(86400), calendar: calendar)
          == .statusFilter)
    }
  }

  @Test func discoveryStatesTakeTheirMatchingTipsUntilASnoozeExpires() {
    for (topic, types) in [
      (TipTopic.buildMachine, [DiscoveryType.slowCold, .newMac, .slotWait]), (.phone, [.away]),
      (.hostedSimulators, [.capHit]),
    ] {
      for type in types {
        #expect(!Tips.taken(topic, states: [:], now: now))
        for state in [DiscoveryState.shown, .never, .snoozed(until: now.addingTimeInterval(1))] {
          #expect(Tips.taken(topic, states: [type: state], now: now))
        }
        #expect(!Tips.taken(topic, states: [type: .snoozed(until: now)], now: now))
        #expect(!Tips.taken(topic, states: [type: .snoozed(until: now.addingTimeInterval(-1))], now: now))
        #expect(!Tips.taken(.tutorial, states: [type: .shown], now: now))
      }
    }
  }

  @Test func aShownTipSuppressesOnlyInformationalDiscoveryTypesOfItsOwnTopic() {
    let shown: [TipTopic: Date] = [.buildMachine: now]
    for type in [DiscoveryType.slowCold, .newMac, .slotWait] {
      #expect(Tips.suppressesDiscovery(type, lastShown: shown))
    }
    for type in [DiscoveryType.lowWithCaches, .away, .capHit] {
      #expect(!Tips.suppressesDiscovery(type, lastShown: shown))
    }
    #expect(Tips.suppressesDiscovery(.away, lastShown: [.phone: now]))
    #expect(!Tips.suppressesDiscovery(.capHit, lastShown: [.hostedSimulators: now]))
    #expect(!Tips.suppressesDiscovery(.away, lastShown: [.tutorial: now]))
    #expect(!Tips.suppressesDiscovery(.away, lastShown: [:]))
  }

  @Test func withoutThePhoneAppNoPhoneTipIsSelected() {
    var inputs = TipInputs()
    inputs.pairedPhones = 0
    var state = TipState()
    for offset in 0..<TipTopic.allCases.count {
      let day = now.addingTimeInterval(Double(offset) * 86400)
      #expect(Tips.select(inputs: inputs, state: &state, discoveries: [:], now: day, calendar: calendar) != .phone)
      #expect(Tips.next(inputs: inputs, state: &state, discoveries: [:], now: day, calendar: calendar) != .phone)
    }
  }

  @Test func nextTipDoesNotRetireTopicsThatShareStateWithDiscovery() {
    var inputs = TipInputs()
    inputs.pairedPhones = 0
    inputs.phoneApp = true
    var state = TipState()
    #expect(Tips.select(inputs: inputs, state: &state, discoveries: [:], now: now, calendar: calendar) == .phone)
    #expect(Tips.next(inputs: inputs, state: &state, discoveries: [:], now: now, calendar: calendar) == .tutorial)
    let later = now.addingTimeInterval(30 * 86400)
    #expect(Tips.available(inputs: inputs, state: state, discoveries: [:], now: later, calendar: calendar).contains(.phone))
  }

  @Test func aDiscoveryTakenTopicIsSkippedAndAnyNoticeHidesTheCard() {
    var inputs = TipInputs()
    inputs.pairedPhones = 0
    inputs.phoneApp = true
    var state = TipState()
    #expect(Tips.select(inputs: inputs, state: &state, discoveries: [.away: .shown], now: now, calendar: calendar) == .tutorial)
    #expect(Tips.visible(gate: true, noticeCount: 0, closedDay: nil, now: now, calendar: calendar))
    #expect(!Tips.visible(gate: true, noticeCount: 1, closedDay: nil, now: now, calendar: calendar))
    #expect(!Tips.visible(gate: false, noticeCount: 0, closedDay: nil, now: now, calendar: calendar))
    #expect(!Tips.visible(gate: true, noticeCount: 0, closedDay: "2026-10-05", now: now, calendar: calendar))
  }

  @Test func emptyStateRequiresKnownEmptyMachinesSuccessfulSettingsAndLocalSelection() {
    func variant(
      gate: Bool = true, machines: [String]? = [], error: String? = nil, selected: String? = nil, macs: [TailnetMac]? = nil
    ) -> BuildMachineEmptyState? {
      Tips.emptyState(gate: gate, machines: machines, settingsError: error, selectedMachine: selected, macs: macs)
    }
    #expect(variant(macs: [mac]) == .addMachine)
    #expect(variant(macs: []) == .tailscale)
    #expect(variant(macs: nil) == nil)
    #expect(variant(gate: false, macs: [mac]) == nil)
    #expect(variant(machines: ["mini"]) == nil)
    #expect(variant(machines: nil) == nil)
    #expect(variant(error: "unavailable") == nil)
    #expect(variant(selected: "mini") == nil)
  }

  @Test func tutorialCompletionRequiresTheDoneRecordStep() {
    withDefaults { defaults in
      let store = TutorialRecordStore(defaults)
      #expect(!store.completed)
      store.record = TutorialRecord(version: 1, startedAt: now, step: "begin")
      #expect(!store.completed)
      store.record = TutorialRecord(version: 1, startedAt: now, step: "done")
      #expect(store.completed)
    }
  }
}
