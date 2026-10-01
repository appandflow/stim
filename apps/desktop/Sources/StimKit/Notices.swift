import Foundation

extension OversightCategory {
  /// The phone's settings label for the category.
  public var label: String {
    switch self {
    case .started: return "Work started"
    case .stuck: return "Agent looks stuck"
    case .looping: return "Agent repeats the same failure"
    case .finished: return "Work finished or PR ready"
    case .machine: return "Machine in trouble"
    case .control: return "Someone takes over your device"
    case .buildRequest: return "A Mac asks to build here"
    case .attention: return "Needs you"
    }
  }

  /// The SF Symbol the phone's inbox shows for the category.
  public var symbol: String {
    switch self {
    case .started: return "play.circle"
    case .stuck: return "hourglass"
    case .looping: return "arrow.triangle.2.circlepath"
    case .finished: return "checkmark.circle"
    case .machine: return "exclamationmark.triangle"
    case .control: return "hand.raised"
    case .buildRequest: return "hammer"
    case .attention: return "exclamationmark.bubble"
    }
  }

  /// Whether a toast of the category stays until dismissed: it asks for the user, not just reports.
  public var needsAttention: Bool {
    switch self {
    case .stuck, .looping, .machine, .control, .buildRequest, .attention: return true
    case .started, .finished: return false
    }
  }

  /// The categories that can fire on Stim Desktop; `control` is a stim-server push to a phone.
  public static let desktop: [OversightCategory] = [.started, .stuck, .looping, .finished, .machine, .attention, .buildRequest]
}

extension OversightTarget {
  /// The call to action that opens the target.
  public var actionTitle: String {
    switch self {
    case .machine: return "Show machine"
    case .workspace: return "Open workspace"
    case .device(_, let platform, _): return platform == "web" ? "Show page" : "Show device"
    case .build: return "Show build"
    case .url: return "Open pull request"
    case .buildRequest: return "Review"
    }
  }

  /// Every string `actionTitle` can render, for UI that reserves a column sized to the widest one.
  public static let actionTitles: [String] = [
    "Show machine", "Open workspace", "Show device", "Show page", "Show build", "Open pull request", "Review",
  ]
}

/// How a category is delivered, with the phone's names: `alert` shows a toast or a banner with sound, `silent` goes
/// only to the inbox, and `off` is kept in the inbox as muted.
public enum NotificationLevel: String, CaseIterable, Sendable {
  case alert, silent, off

  public var title: String { rawValue.capitalized }
}

extension OversightCategory {
  /// Every category starts Silent, except a build request: it waits on an answer from this Mac and lapses after
  /// 15 minutes.
  public var defaultLevel: NotificationLevel { self == .buildRequest ? .alert : .silent }
}

/// Stim Desktop's notification settings, in its own `UserDefaults`.
public enum NotificationSettings {
  public static let stuckMinutesKey = "notify.stuckMinutes"
  public static let quietHoursKey = "notify.quietHours"
  /// The ids of the `attention` notifications still in their episode, kept so a restart does not repeat them.
  public static let attentionKey = "notify.attention"
  public static let stuckMinuteChoices = [5, 10, 15, 30, 60]
  /// The phone's quiet hours choices, stored as `start-end` minutes after midnight.
  public static let quietHoursChoices: [(label: String, value: String)] = [
    ("Off", "off"), ("10 PM to 7 AM", "1320-420"), ("11 PM to 8 AM", "1380-480"), ("Midnight to 8 AM", "0-480"),
  ]

  public static func key(_ category: OversightCategory) -> String { "notify.level.\(category.rawValue)" }

  public static var defaults: [String: Any] {
    var out: [String: Any] = [stuckMinutesKey: Oversight.defaultStuckMinutes, quietHoursKey: "off"]
    for category in OversightCategory.desktop { out[key(category)] = category.defaultLevel.rawValue }
    return out
  }

  public static func level(_ category: OversightCategory, _ defaults: UserDefaults) -> NotificationLevel {
    defaults.string(forKey: key(category)).flatMap(NotificationLevel.init(rawValue:)) ?? category.defaultLevel
  }

  /// `start-end` as quiet hours; anything else is none.
  public static func quietHours(_ value: String?) -> QuietHours? {
    let parts = (value ?? "").split(separator: "-").map { Int($0) }
    guard parts.count == 2, let start = parts[0], let end = parts[1], (0..<1440).contains(start),
      (0..<1440).contains(end)
    else { return nil }
    return QuietHours(start: start, end: end)
  }

  /// Whether quiet hours hold alerts now; `minuteOfDay` is the local time.
  public static func isQuiet(_ defaults: UserDefaults, minuteOfDay: Int) -> Bool {
    Oversight.inQuietHours(quietHours(defaults.string(forKey: quietHoursKey)), minuteOfDay: minuteOfDay)
  }

  /// The rules' preferences: every category and no quiet hours, so the inbox records all of them. The level and
  /// quiet hours decide only how each is presented.
  public static func prefs(_ defaults: UserDefaults) -> OversightPrefs {
    let stuck = defaults.integer(forKey: stuckMinutesKey)
    return OversightPrefs(
      categories: OversightCategory.desktop,
      stuckMinutes: (1...240).contains(stuck) ? stuck : Oversight.defaultStuckMinutes, quiet: false)
  }
}
