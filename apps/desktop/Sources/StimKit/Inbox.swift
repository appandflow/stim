import Foundation

/// Why a notification reached the inbox without alerting, with the phone inbox's names.
public enum NoticeSuppression: String, Codable, Sendable {
  case muted
  case quietHours = "quiet-hours"

  public var title: String {
    switch self {
    case .muted: return "Muted"
    case .quietHours: return "Quiet hours"
    }
  }
}

/// One notification Stim Desktop delivered, as its inbox keeps it.
public struct InboxEntry: Codable, Hashable, Identifiable, Sendable {
  public var id: String
  public var category: OversightCategory
  public var title: String
  public var body: String
  public var target: OversightTarget
  public var date: Date
  public var read: Bool
  public var suppressed: NoticeSuppression?

  public init(
    id: String = UUID().uuidString, notification: OversightNotification, date: Date,
    suppressed: NoticeSuppression? = nil
  ) {
    self.id = id
    category = notification.category
    title = notification.title
    body = notification.body
    target = notification.target
    self.date = date
    read = false
    self.suppressed = suppressed
  }
}

/// The inbox's filters; nil shows every category or workspace. A workspace filter of `""` shows machine entries.
public struct InboxFilter: Equatable, Sendable {
  public var category: OversightCategory?
  public var workspace: String?

  public init(category: OversightCategory? = nil, workspace: String? = nil) {
    self.category = category
    self.workspace = workspace
  }

  public func matches(_ entry: InboxEntry) -> Bool {
    (category == nil || entry.category == category) && (workspace == nil || (entry.target.path ?? "") == workspace)
  }
}

/// Stim Desktop's notification history, newest first: at most `limit` entries, none older than `maxAge`.
public struct Inbox: Codable, Equatable, Sendable {
  public static let limit = 200
  public static let maxAge: TimeInterval = 7 * 24 * 3600

  public private(set) var entries: [InboxEntry] = []

  public init(entries: [InboxEntry] = []) {
    self.entries = entries
  }

  private enum Keys: String, CodingKey { case entries }

  private struct Lossy: Decodable {
    var entry: InboxEntry?
    init(from decoder: Decoder) throws { entry = try? InboxEntry(from: decoder) }
  }

  /// Skips an entry it cannot read, such as one a newer Stim Desktop wrote, instead of dropping the history.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    entries = try c.decode([Lossy].self, forKey: .entries).compactMap(\.entry)
  }

  /// How a notification at `level` is delivered: whether it interrupts with a toast or a banner, and the label it
  /// carries in the inbox. Quiet hours hold an alert back.
  public static func delivery(
    _ level: NotificationLevel, quiet: Bool
  ) -> (interrupts: Bool, suppressed: NoticeSuppression?) {
    switch level {
    case .alert: return quiet ? (false, .quietHours) : (true, nil)
    case .silent: return (false, nil)
    case .off: return (false, .muted)
    }
  }

  public var unreadCount: Int { entries.lazy.filter { !$0.read }.count }

  public mutating func add(_ entry: InboxEntry, now: Date) {
    entries.insert(entry, at: 0)
    prune(now: now)
  }

  public mutating func prune(now: Date) {
    entries = Array(entries.filter { now.timeIntervalSince($0.date) < Self.maxAge }.prefix(Self.limit))
  }

  public mutating func markRead(_ id: String) {
    guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
    entries[index].read = true
  }

  /// Marks what the filter shows as read, like the phone's Mark all read.
  public mutating func markAllRead(_ filter: InboxFilter = InboxFilter()) {
    for index in entries.indices where filter.matches(entries[index]) { entries[index].read = true }
  }

  /// Removes what the filter shows.
  public mutating func clear(_ filter: InboxFilter = InboxFilter()) {
    entries.removeAll { filter.matches($0) }
  }

  /// The entries the filter shows, grouped by local day, newest first.
  public func days(_ filter: InboxFilter, calendar: Calendar = .current) -> [(day: Date, entries: [InboxEntry])] {
    var out: [(day: Date, entries: [InboxEntry])] = []
    for entry in entries where filter.matches(entry) {
      let day = calendar.startOfDay(for: entry.date)
      if out.last?.day == day {
        out[out.count - 1].entries.append(entry)
      } else {
        out.append((day, [entry]))
      }
    }
    return out
  }

  private var newestTitles: [(path: String, title: String)] {
    var seen: [(path: String, title: String)] = []
    for entry in entries {
      guard let path = entry.target.path, !seen.contains(where: { $0.path == path }) else { continue }
      seen.append((path, entry.title))
    }
    return seen
  }

  private func qualifiers() -> [String: String] {
    nameQualifiers(newestTitles.map { ($0.path, $0.title) })
  }

  private static func qualified(_ title: String, _ qualifier: String?) -> String {
    qualifier.map { "\(title) (\($0))" } ?? title
  }

  /// The workspaces with entries, by path, each named by its newest entry's title, in first-seen order. Workspaces
  /// sharing a title carry their enclosing folders, such as `app (work)`.
  public var workspaces: [(path: String, title: String)] {
    let qualifiers = qualifiers()
    return newestTitles.map { ($0.path, Self.qualified($0.title, qualifiers[$0.path])) }
  }

  /// What each entry shows as its title, by entry id: its own, with the workspace's enclosing folders when another
  /// workspace in the inbox shares that title.
  public var displayTitles: [String: String] {
    let qualifiers = qualifiers()
    var titles: [String: String] = [:]
    for entry in entries {
      titles[entry.id] = Self.qualified(entry.title, entry.target.path.flatMap { qualifiers[$0] })
    }
    return titles
  }
}
