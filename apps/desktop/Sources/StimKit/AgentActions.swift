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
