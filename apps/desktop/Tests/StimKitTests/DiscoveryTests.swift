import Foundation
import Testing

@testable import StimKit

struct DiscoveryTests {
  let now = Date(timeIntervalSince1970: 1_791_284_400)
  let mini = TailnetMac(id: "mini", hostName: "Mini", dnsName: "mini.tail.test")
  let studio = TailnetMac(id: "studio", hostName: "Studio", dnsName: "studio.tail.test")

  func placement(
    age: TimeInterval = 0, ms: Double = 240_000, wait: Double? = nil,
    decision: BuildPlacements.Placement.Decision = .here, failed: Bool = false
  ) -> BuildPlacements.Placement {
    BuildPlacements.Placement(
      at: ISO8601DateFormatter().string(from: now.addingTimeInterval(-age)), project: "/fixture", platform: "ios",
      decision: decision, reason: "build", buildMs: ms, failed: failed, slotWaitMs: wait)
  }

  func cold(_ placements: [BuildPlacements.Placement], machines: [String] = [], macs: [TailnetMac]? = nil) -> DiscoveryPrompt? {
    Discovery.slowCold(placements: placements, machines: machines, macs: macs ?? [studio, mini], now: now)
  }

  @Test func slowColdRequiresThreeBuildsAndAnAverageStrictlyOverThreeMinutes() {
    #expect(cold(Array(repeating: placement(ms: 180_000), count: 3)) == nil)
    #expect(cold(Array(repeating: placement(ms: 180_001), count: 2)) == nil)
    let prompt = cold(Array(repeating: placement(ms: 180_001), count: 3))
    #expect(prompt?.action == .addMachine(mac: mini, hostedSimulators: false))
    #expect(
      cold([placement(ms: 120_000), placement(ms: 120_000), placement(ms: 360_000)])?.title
        == "Cold builds take ~3 min. Build on mini instead?")
  }

  @Test func slowColdIncludesTheSeventhDayButExcludesOlderAndFutureBuilds() {
    #expect(cold(Array(repeating: placement(age: Discovery.week), count: 3)) != nil)
    #expect(cold([placement(), placement(), placement(age: 8 * 86400)]) == nil)
    #expect(cold([placement(), placement(), placement(age: -1)]) == nil)
  }

  @Test func slowColdIgnoresOffloadedFailedAndZeroDurationBuilds() {
    for excluded in [placement(decision: .offloaded), placement(decision: .fellBack), placement(failed: true), placement(ms: 0)] {
      #expect(cold([placement(), placement(), excluded]) == nil)
    }
  }

  @Test func slowColdRequiresAnUnconfiguredMacAndAnOnlinePeer() {
    let placements = Array(repeating: placement(), count: 3)
    #expect(cold(placements, machines: ["mini"]) == nil)
    #expect(cold(placements, macs: []) == nil)
  }

  @Test func newMacRecordsTheFirstBaselineWithoutSuggestingIt() {
    let first = Discovery.newMac(macs: [mini], seen: nil, machines: [], now: now)
    #expect(first.prompt == nil)
    #expect(first.seen == [mini.id])
    let later = Discovery.newMac(macs: [mini, studio], seen: first.seen, machines: [], now: now)
    #expect(later.prompt?.action == .addMachine(mac: studio, hostedSimulators: false))
    #expect(later.seen == [mini.id, studio.id])
  }

  @Test func newMacSuppressesSeenAndConfiguredPeersWithoutLosingTheirIDs() {
    #expect(Discovery.newMac(macs: [mini], seen: [mini.id], machines: [], now: now).prompt == nil)
    for entry in ["MINI:7444", "mini.tail.test:7443"] {
      let result = Discovery.newMac(macs: [mini], seen: ["old"], machines: [entry], now: now)
      #expect(result.prompt == nil)
      #expect(result.seen == ["old", mini.id])
    }
    #expect(Discovery.newMac(macs: [], seen: ["old"], machines: [], now: now).seen == ["old"])
  }

  @Test func newMacPicksTheFirstUnseenDNSNameInsteadOfInputOrder() {
    let result = Discovery.newMac(macs: [studio, mini], seen: [], machines: [], now: now)
    #expect(result.prompt?.action == .addMachine(mac: mini, hostedSimulators: false))
  }

  @Test func slotWaitRequiresThreeWaitsStrictlyLongerThanAMinute() {
    func prompt(_ placements: [BuildPlacements.Placement]) -> DiscoveryPrompt? {
      Discovery.slotWait(placements: placements, macs: [studio, mini], now: now)
    }
    #expect(prompt(Array(repeating: placement(wait: 60_000), count: 3)) == nil)
    #expect(prompt(Array(repeating: placement(wait: 60_001), count: 2)) == nil)
    let fired = prompt(Array(repeating: placement(wait: 60_001), count: 3))
    #expect(fired?.detail == "3 builds this week")
    #expect(fired?.action == .addMachine(mac: mini, hostedSimulators: false))
  }

  @Test func slotWaitCountsSevenDayOldWaitsButNotOlderOrFutureWaits() {
    func prompt(_ age: TimeInterval) -> DiscoveryPrompt? {
      Discovery.slotWait(placements: Array(repeating: placement(age: age, wait: 60_001), count: 3), macs: [], now: now)
    }
    #expect(prompt(Discovery.week)?.action == .addMachine(mac: nil, hostedSimulators: false))
    #expect(prompt(Discovery.week + 1) == nil)
    #expect(prompt(-1) == nil)
  }

  @Test func cacheSuggestionRequiresPressureAndMoreThanTwentyGiB() {
    let plan = PressurePlan.make(freeBytes: 0, minimumFreeGb: 1, hardFloorGb: 0, report: nil)
    let boundary: Int64 = 20 * 1_073_741_824
    #expect(Discovery.lowWithCaches(plan: plan, cacheBytes: boundary, mac: mini) == nil)
    #expect(Discovery.lowWithCaches(plan: nil, cacheBytes: boundary + 1, mac: mini) == nil)
    #expect(Discovery.lowWithCaches(plan: plan, cacheBytes: nil, mac: mini) == nil)
    #expect(Discovery.lowWithCaches(plan: plan, cacheBytes: boundary + 1, mac: mini)?.secondaryAction == .reviewCaches)
    #expect(
      Discovery.lowWithCaches(plan: plan, cacheBytes: 48 * 1_073_741_824, mac: nil)?.title
        == "Native caches use 48 GB. Build on another Mac?")
  }

  @Test func capacitySuggestionRequiresAFailedCapacityRefusalAndChoosesHostingOnly() {
    #expect(Discovery.capHit(lines: ["STIM_AT_CAPACITY"], exitStatus: 0, mac: mini) == nil)
    #expect(Discovery.capHit(lines: ["STIM_LOW_DISK"], exitStatus: 1, mac: mini) == nil)
    #expect(
      Discovery.capHit(lines: ["progress", "error: STIM_AT_CAPACITY: limit"], exitStatus: 1, mac: mini)?.action
        == .addMachine(mac: mini, hostedSimulators: true))
    #expect(
      Discovery.capHit(lines: ["STIM_AT_CAPACITY"], exitStatus: 1, mac: nil)?.title
        == "Device limit reached. Run simulators on another Mac?")
  }

  func refusal(age: TimeInterval = 0, kind: String = "device", at: String? = nil) -> CapacityRefusal {
    CapacityRefusal(
      at: at ?? ISO8601DateFormatter().string(from: now.addingTimeInterval(-age)),
      kind: kind, platform: "ios", max: 2, workspace: "fixture")
  }

  @Test func capacityEventsRequireADeviceRefusalWithinSixHours() throws {
    func evaluate(_ event: CapacityRefusal) -> DiscoveryPrompt? {
      Discovery.capHit(events: [event], now: now, mac: mini)?.prompt
    }
    #expect(evaluate(refusal(age: 5 * 3600 + 59 * 60))?.action == .addMachine(mac: mini, hostedSimulators: true))
    #expect(evaluate(refusal(age: 6 * 3600)) != nil)
    #expect(evaluate(refusal(age: 6 * 3600 + 60)) == nil)
    #expect(evaluate(refusal(age: -1)) == nil)
    #expect(evaluate(refusal(at: "bad-date")) == nil)
    #expect(evaluate(refusal(kind: "build")) == nil)
    #expect(Discovery.capHit(events: [], now: now, mac: mini) == nil)
    let event = try #require(Discovery.capHit(events: [refusal()], now: now, mac: nil))
    #expect(event.prompt == Discovery.capHit(lines: ["STIM_AT_CAPACITY"], exitStatus: 1, mac: nil))
  }

  @Test func newestCapacityEventKeepsItsOwnTimeSoPollingCannotRenewItsLifetime() throws {
    let newest = now.addingTimeInterval(-(5 * 3600 + 59 * 60))
    let event = try #require(
      Discovery.capHit(
        events: [refusal(age: 6 * 3600), refusal(age: -1), refusal(age: 5 * 3600 + 59 * 60), refusal(at: "invalid")],
        now: now, mac: mini))
    #expect(event.rememberedAt == newest)
    #expect(Discovery.fresh(event.prompt.type, rememberedAt: event.rememberedAt, now: now))
    #expect(!Discovery.fresh(event.prompt.type, rememberedAt: event.rememberedAt, now: now.addingTimeInterval(120)))
  }

  @Test func awayRequiresALongRunAnIdleUserAndNoPairedPhone() {
    #expect(Discovery.away(pairedPhones: 0, durationMs: 600_000, idleSeconds: 301) == nil)
    #expect(Discovery.away(pairedPhones: 0, durationMs: 600_001, idleSeconds: 300) == nil)
    #expect(Discovery.away(pairedPhones: 1, durationMs: 600_001, idleSeconds: 301) == nil)
    let prompt = Discovery.away(pairedPhones: 0, durationMs: 600_001, idleSeconds: 301)
    #expect(prompt?.surface == .notification)
    #expect(prompt?.action == .pairPhone)
  }

  @Test func stateRoundTripPreservesDismissalAndSnoozeDates() {
    for state in [DiscoveryState.shown, .never, .snoozed(until: now.addingTimeInterval(0.125))] {
      #expect(DiscoveryState.parse(state.encoded) == state)
    }
    #expect(DiscoveryState.parse(nil) == nil)
    #expect(Discovery.eligible(nil, now: now))
  }

  @Test func notNowAllowsShowingAgainExactlyAfterSevenDays() {
    let snoozed = Discovery.dismissed(previous: nil, now: now)
    #expect(snoozed == .snoozed(until: now.addingTimeInterval(Discovery.week)))
    #expect(!Discovery.eligible(snoozed, now: now.addingTimeInterval(7 * 86400 - 1)))
    #expect(Discovery.eligible(snoozed, now: now.addingTimeInterval(7 * 86400)))
    #expect(Discovery.eligible(snoozed, now: now.addingTimeInterval(8 * 86400)))
  }

  @Test func dismissingTheOneReshowConsumesTheSuggestion() {
    let snoozed = Discovery.dismissed(previous: nil, now: now)
    let later = now.addingTimeInterval(Discovery.week)
    #expect(Discovery.eligible(snoozed, now: later))
    let dismissed = Discovery.dismissed(previous: snoozed, now: later)
    #expect(dismissed == .shown)
    #expect(!Discovery.eligible(dismissed, now: later))
    #expect(!Discovery.eligible(dismissed, now: .distantFuture))
  }

  @Test func eventPromptsExpireAfterTenMinutesOrSixHours() {
    for (type, lifetime) in [(DiscoveryType.away, 10 * 60), (.capHit, 6 * 60 * 60)] {
      #expect(Discovery.fresh(type, rememberedAt: now, now: now.addingTimeInterval(Double(lifetime))))
      #expect(!Discovery.fresh(type, rememberedAt: now, now: now.addingTimeInterval(Double(lifetime + 1))))
    }
    #expect(Discovery.fresh(.newMac, rememberedAt: now, now: now.addingTimeInterval(Discovery.week)))
  }

  @Test func closedWindowLeavesBannersEligibleAndDoesNotBlockNotifications() throws {
    let banner = try #require(cold(Array(repeating: placement(), count: 3)))
    let notification = try #require(Discovery.away(pairedPhones: 0, durationMs: 600_001, idleSeconds: 301))
    #expect(Discovery.select([banner], states: [:], now: now, bannersAvailable: false) == nil)
    #expect(Discovery.select([banner, notification], states: [:], now: now, bannersAvailable: false) == notification)
    #expect(Discovery.select([banner], states: [:], now: now, bannersAvailable: true) == banner)
  }

  @Test func shownPermanentDismissalAndMalformedValuesNeverNag() {
    for value in ["shown", "never", "unexpected", "snoozed:bad-date", ""] {
      #expect(!Discovery.eligible(DiscoveryState.parse(value), now: now))
      #expect(!Discovery.eligible(DiscoveryState.parse(value), now: .distantFuture))
    }
  }

  @Test func gateRequiresCompletedSetupAndASecondLaunchAndNoRunningBuild() throws {
    let workspace = try JSONDecoder().decode(
      Workspace.self,
      from: Data(
        """
        {"path":"/fixture","live":false,"warnings":[],"build":{"platform":"ios","slot":"default","state":"running",
        "phase":"install","startedAt":"2026-10-06T00:00:00Z","phaseStartedAt":"2026-10-06T00:00:00Z","basis":0}}
        """.utf8))
    func gate(_ workspaces: [Workspace] = [], completed: Bool = true, launches: Int = 2) -> Bool {
      Discovery.gate(
        workspaces: workspaces, setupCompleted: completed, launches: launches, lastShown: nil, now: now,
        calendar: Calendar(identifier: .gregorian))
    }
    #expect(!gate([workspace]))
    #expect(!gate(completed: false))
    #expect(!gate(launches: 1))
    #expect(gate(launches: 2))
  }

  @Test func gateLimitsSuggestionsByLocalCalendarDayRatherThanElapsedHours() throws {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = try #require(TimeZone(identifier: "America/Toronto"))
    let shown = try #require(parseTimestamp("2026-10-06T23:59:00-04:00"))
    func gate(_ date: Date) -> Bool {
      Discovery.gate(workspaces: [], setupCompleted: true, launches: 2, lastShown: shown, now: date, calendar: calendar)
    }
    #expect(!gate(shown.addingTimeInterval(30)))
    #expect(gate(shown.addingTimeInterval(60)))
  }

  @Test func selectionUsesTableOrderAndLeavesTheOtherCandidateEligible() throws {
    let early = try #require(cold(Array(repeating: placement(), count: 3)))
    let late = try #require(Discovery.away(pairedPhones: 0, durationMs: 600_001, idleSeconds: 301))
    #expect(Discovery.select([late, early], states: [:], now: now)?.type == .slowCold)
    #expect(Discovery.select([late, early], states: [.slowCold: .shown], now: now)?.type == .away)
  }

  @Test func displayingConsumesTheKindAndRecordsTheDayForTheNextLaunch() throws {
    let suite = "DiscoveryTests.\(UUID())"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = DiscoveryStore(defaults: defaults)
    let prompt = try #require(Discovery.capHit(lines: ["STIM_AT_CAPACITY"], exitStatus: 1, mac: nil))
    store.shown(prompt, now: now)
    let nextLaunch = DiscoveryStore(defaults: defaults)
    #expect(nextLaunch.state(.capHit) == .shown)
    #expect(nextLaunch.lastShown == now)
    #expect(Discovery.select([prompt], states: nextLaunch.states, now: now.addingTimeInterval(86400)) == nil)
  }

  @Test func storePersistsPerKindAndKeepsDismissalAcrossReaders() throws {
    let suite = "DiscoveryTests.\(UUID())"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let store = DiscoveryStore(defaults: defaults)
    #expect(store.state(.slowCold) == nil)
    store.launched()
    store.launched()
    #expect(DiscoveryStore(defaults: defaults).launches == 2)
    store.set(.never, for: .slowCold)
    #expect(defaults.string(forKey: "discovery.offload.slowCold") == "never")
    #expect(DiscoveryStore(defaults: defaults).state(.slowCold) == .never)
    store.set(Discovery.snooze(now: now), for: .away)
    #expect(store.state(.away) == .snoozed(until: now.addingTimeInterval(7 * 86400)))
    defaults.set(17, forKey: "discovery.devices.capHit")
    #expect(store.state(.capHit) == .shown)
    store.seenPeers = ["mini"]
    #expect(DiscoveryStore(defaults: defaults).seenPeers == ["mini"])
    store.lastShown = now
    #expect(DiscoveryStore(defaults: defaults).lastShown == now)
  }
}
