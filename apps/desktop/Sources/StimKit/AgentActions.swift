import Foundation

/// One agent action on a device, as the phone's `AgentAction`: `key` stays the same as later actions arrive, and two
/// identical actions in the same millisecond get distinct keys.
public struct AgentAction: Sendable {
  public var key: Int
  public var record: LogRecord

  public init(key: Int, record: LogRecord) {
    self.key = key
    self.record = record
  }

  public var failed: Bool { record.level == .error }

  /// When the action started, which is where stim-server puts its replay marker: agent-device's `startedAt` when the
  /// record has it, else the record's time.
  public var at: Double { record.startedAt ?? record.ts }

  /// The device's own agent actions of `incoming` added to `existing`, newest first, keeping at most `max`.
  public static func appending(
    _ incoming: [LogRecord], to existing: [AgentAction], deviceID: String, max: Int
  ) -> [AgentAction] {
    let mine = incoming.filter { $0.source == .agent && $0.deviceId == deviceID }
    guard !mine.isEmpty else { return existing }
    let base = existing.first?.key ?? 0
    let added = mine.enumerated().map { AgentAction(key: base + $0.offset + 1, record: $0.element) }.reversed()
    return Array((added + existing).prefix(max))
  }
}

/// Which agent actions a device's action log shows.
public enum AgentFilter: Hashable, Sendable {
  case all
  case failed
  case command(String)

  public func matches(_ action: AgentAction) -> Bool {
    switch self {
    case .all: return true
    case .failed: return action.failed
    case .command(let command): return action.record.command == command
    }
  }

  public struct Option: Hashable, Sendable {
    public var filter: AgentFilter
    public var label: String
    public var count: Int
  }

  /// All, then Failed when any failed, then the two most used commands, each with its count.
  public static func options(_ actions: [AgentAction]) -> [Option] {
    let failed = actions.filter(\.failed).count
    var counts: [String: Int] = [:]
    for action in actions {
      if let command = action.record.command, !command.isEmpty { counts[command, default: 0] += 1 }
    }
    let commands = counts.sorted {
      $0.value != $1.value ? $0.value > $1.value : $0.key.localizedCompare($1.key) == .orderedAscending
    }
    .prefix(2)
    return [Option(filter: .all, label: "All", count: actions.count)]
      + (failed > 0 ? [Option(filter: .failed, label: "Failed", count: failed)] : [])
      + commands.map { Option(filter: .command($0.key), label: $0.key, count: $0.value) }
  }
}

/// The device viewer's agent actions, oldest first as a session replay lists its events, with a gap row before an
/// action that came more than `gapMs` after the one above it.
public struct AgentActionList: Sendable {
  public enum Row: Sendable {
    case gap(ms: Double, before: Int)
    case action(AgentAction)
  }

  public static let gapMs = 5 * 60_000.0

  /// The actions `filter` keeps, oldest first.
  public let actions: [AgentAction]

  /// `actions` newest first, as `AgentAction.appending` keeps them.
  public init(_ actions: [AgentAction], filter: AgentFilter = .all) {
    self.actions = actions.filter(filter.matches).reversed()
  }

  public var rows: [Row] {
    var rows: [Row] = []
    for (index, action) in actions.enumerated() {
      if index > 0, action.at - actions[index - 1].at > Self.gapMs {
        rows.append(.gap(ms: action.at - actions[index - 1].at, before: action.key))
      }
      rows.append(.action(action))
    }
    return rows
  }

  /// The action on screen: the newest while live. While replaying, the last action at or before the frame shown at
  /// `at`, or at or before `stepped`, the action last stepped or clicked to, while the playhead has not reached it,
  /// since a seek lands just before the action. Nil before the first action, or before the first frame arrives with
  /// nothing stepped to.
  public func current(live: Bool, at: Double?, stepped: Double?) -> Int? {
    if live { return actions.last?.key }
    guard let anchor = [at, stepped].compactMap({ $0 }).max() else { return nil }
    return actions.last { $0.at <= anchor }?.key
  }

  /// The action after or before the one keyed `key`, for moving through the list with the arrow keys; from no action,
  /// or one the list does not show, the first or the last. Nil past either end.
  public func adjacent(to key: Int?, forward: Bool) -> AgentAction? {
    guard let key, let index = actions.firstIndex(where: { $0.key == key }) else {
      return forward ? actions.first : actions.last
    }
    let next = index + (forward ? 1 : -1)
    return actions.indices.contains(next) ? actions[next] : nil
  }
}
