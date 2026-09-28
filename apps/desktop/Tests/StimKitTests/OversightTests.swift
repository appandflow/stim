import Foundation
import StimKit
import Testing

/// Replays the runs `packages/server/__tests__/oversight.test.ts` records, step by step.
struct OversightTests {
  struct Vectors: Decodable {
    struct Step: Decodable {
      var at: Double
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

    var oversee: [Run]
    var quietHours: [QuietCase]
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
        let result = Oversight.oversee(previous: state, input: step.input, prefs: step.prefs, now: step.at)
        state = result.state
        #expect(result.notifications == step.notifications, "\(run.name), step \(index + 1)")
        #expect(result.wakeAt == step.wakeAt, "\(run.name), step \(index + 1)")
      }
    }
  }

  @Test func readsQuietHoursLikeTheTypeScriptRules() {
    for c in Self.vectors.quietHours {
      #expect(Oversight.inQuietHours(c.quietHours, minuteOfDay: c.minuteOfDay) == c.quiet, "\(c)")
    }
  }
}
