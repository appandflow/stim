import Foundation
import StimKit
import Testing

/// Replays the runs `packages/server/__tests__/oversight.test.ts` records, step by step.
struct OversightTests {
  struct Vectors: Decodable {
    struct Step: Decodable {
      var at: Double
      var awakeSince: Double?
      var input: OversightInput
      var prefs: OversightPrefs
      var notifications: [OversightNotification]
      var wakeAt: Double?
    }

    struct Run: Decodable {
      var name: String
      var steps: [Step]
    }

    struct QuietCase: Decodable {
      var quietHours: QuietHours?
      var minuteOfDay: Int
      var quiet: Bool
    }

    struct Titles: Decodable {
      var status: OversightStatus
      var titles: [String]
    }

    var oversee: [Run]
    var quietHours: [QuietCase]
    var titles: Titles
  }

  static let vectors: Vectors = {
    let url = Bundle.module.url(forResource: "oversight-vectors", withExtension: "json", subdirectory: "Fixtures")!
    return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }()

  @Test func notifiesWhatTheTypeScriptRulesNotifyAtEveryStep() {
    #expect(Self.vectors.oversee.count > 20)
    for run in Self.vectors.oversee {
      var state: OversightState?
      for (index, step) in run.steps.enumerated() {
        let result = Oversight.oversee(
          previous: state, input: step.input, prefs: step.prefs, now: step.at, awakeSince: step.awakeSince ?? 0)
        state = result.state
        #expect(result.notifications == step.notifications, "\(run.name), step \(index + 1)")
        #expect(result.wakeAt == step.wakeAt, "\(run.name), step \(index + 1)")
      }
    }
  }

  private func stop(
    _ state: OversightState?, live: Bool, driven: Bool, minute: Double
  ) throws -> OversightResult {
    let json = """
      {"machine": "Mac", "pullRequests": {}, "ownLeases": [], "status": {"environments": [{"path": "/w/app", "live": \(live),
      "ios": {"name": "iPhone 18", "state": "Booted", "activity": {"state": "\(driven ? "driven" : "idle")",
      "driver": {"tool": "agent-device"}}},
      "lastBuilds": {"ios": {"platform": "ios", "status": "ok", "startedAt": "2026-10-02T00:00:00Z"}}}]}}
      """
    let input = try JSONDecoder().decode(OversightInput.self, from: Data(json.utf8))
    let prefs = OversightPrefs(categories: OversightCategory.desktop, stuckMinutes: 240, quiet: false)
    return Oversight.oversee(previous: state, input: input, prefs: prefs, now: 1_790_899_200_000 + minute * 60_000)
  }

  @Test func notifiesFinishedOncePerLiveRunEvenWhenTheAgentStopsAgain() throws {
    var state = try stop(nil, live: true, driven: false, minute: 0).state
    func settle(_ minute: Double) throws -> [OversightNotification] {
      let first = try stop(state, live: true, driven: true, minute: minute)
      let released = try stop(first.state, live: true, driven: false, minute: minute + 1)
      let due = try stop(released.state, live: true, driven: false, minute: minute + 10)
      state = due.state
      return first.notifications + released.notifications + due.notifications
    }
    let a = try settle(1).map(\.category)
    #expect(a == [.started, .finished])
    let b = try settle(20).map(\.category)
    #expect(b == [.started])

    state = try stop(state, live: false, driven: false, minute: 40).state
    state = try stop(state, live: true, driven: false, minute: 41).state
    let c = try settle(50).map(\.category)
    #expect(c == [.started, .finished])
  }

  @Test func namesEachWorkspaceOfACapturedStatusLikeTheTypeScriptRules() {
    let status = Self.vectors.titles.status
    #expect(status.environments.map { Oversight.title($0, status: status) } == Self.vectors.titles.titles)
  }

  @Test func readsQuietHoursLikeTheTypeScriptRules() {
    for c in Self.vectors.quietHours {
      #expect(Oversight.inQuietHours(c.quietHours, minuteOfDay: c.minuteOfDay) == c.quiet, "\(c)")
    }
  }
}
