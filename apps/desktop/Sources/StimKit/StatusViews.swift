import Foundation

/// The status stim-server's view subscriptions describe, kept as the JSON they carry: the workspaces and unprovisioned
/// worktrees by path in server order from `workspaces` events, the machine from `machine` events, the archives read
/// from `archived.list`, and the full environment of each workspace a `workspace` subscription follows.
public struct StatusViews: Sendable {
  public enum Outcome: Equatable, Sendable {
    /// The event changed what `payload()` returns.
    case changed
    /// The event changed nothing that `payload()` returns.
    case unchanged
    /// An event is missing before this one; subscribe again for a new snapshot.
    case gap
  }

  private var workspaceOrder: [String] = []
  private var workspaces: [String: JSONValue] = [:]
  private var worktreeOrder: [String] = []
  private var worktrees: [String: JSONValue] = [:]
  private var nextSeq: Int?
  public private(set) var archivedSummary: JSONValue?
  private var machine: [String: JSONValue] = [:]
  private var archives: [JSONValue]?
  private var archivedUsage: JSONValue?
  private var details: [String: JSONValue] = [:]

  public init() {}

  /// Starts fresh workspace views while retaining machine and archive values until their replacements arrive.
  public init(retainingMachineAndArchives previous: StatusViews) {
    machine = previous.machine
    archives = previous.archives
    archivedUsage = previous.archivedUsage
  }

  /// Whether a `workspaces` snapshot arrived, so `payload()` lists the workspaces.
  public var hasWorkspaces: Bool { nextSeq != nil }

  /// Applies one `workspaces` event.
  public mutating func applyWorkspaces(_ fields: [String: JSONValue]) -> Outcome {
    guard let number = fields["seq"]?.number else { return .unchanged }
    let seq = Int(number)
    if case .object(let snapshot)? = fields["snapshot"] {
      (workspaceOrder, workspaces) = Self.keyed(snapshot["workspaces"])
      (worktreeOrder, worktrees) = Self.keyed(snapshot["worktrees"])
      archivedSummary = snapshot["archived"]
      nextSeq = seq + 1
      return .changed
    }
    guard seq == nextSeq else { return .gap }
    nextSeq = seq + 1
    Self.apply(fields["workspaces"], order: &workspaceOrder, entities: &workspaces)
    Self.apply(fields["worktrees"], order: &worktreeOrder, entities: &worktrees)
    if let archived = fields["archived"] { archivedSummary = archived }
    return .changed
  }

  /// Applies one `machine` event.
  public mutating func applyMachine(_ fields: [String: JSONValue]) -> Outcome {
    guard case .object(let view)? = fields["machine"] else { return .unchanged }
    machine = view
    return .changed
  }

  /// Sets the archives an `archived.list` read returned, all pages together.
  public mutating func setArchives(_ archived: [JSONValue], usage: JSONValue?) {
    archives = archived
    archivedUsage = usage
  }

  /// Replaces the summary of `path` with its full environment, or stops doing so for nil.
  public mutating func setDetail(_ environment: JSONValue?, for path: String) -> Outcome {
    let previous = details[path]
    if case .object? = environment { details[path] = environment } else { details[path] = nil }
    return details[path] == previous ? .unchanged : .changed
  }

  /// The status these views describe, shaped like a `stim status --json` payload.
  public func payload() -> JSONValue {
    var payload: [String: JSONValue] = [
      "environments": .array(workspaceOrder.compactMap { details[$0] ?? workspaces[$0] }),
      "unprovisionedWorktrees": .array(worktreeOrder.compactMap { worktrees[$0] }),
    ]
    for key in ["capacity", "machine", "deviceLeases", "simctlAvailable", "maintenance"] {
      if let value = machine[key], value != .null { payload[key] = value }
    }
    if let archives { payload["archived"] = .array(archives) }
    if let archivedUsage { payload["archivedUsage"] = archivedUsage }
    return .object(payload)
  }

  private static func path(_ entity: JSONValue) -> String? {
    guard case .object(let fields) = entity else { return nil }
    return fields["path"]?.string
  }

  private static func keyed(_ list: JSONValue?) -> ([String], [String: JSONValue]) {
    guard case .array(let entities)? = list else { return ([], [:]) }
    var order: [String] = []
    var byPath: [String: JSONValue] = [:]
    for entity in entities {
      guard let path = path(entity) else { continue }
      if byPath[path] == nil { order.append(path) }
      byPath[path] = entity
    }
    return (order, byPath)
  }

  private static func apply(_ delta: JSONValue?, order: inout [String], entities: inout [String: JSONValue]) {
    guard case .object(let fields)? = delta else { return }
    if case .array(let removed)? = fields["remove"] {
      let gone = Set(removed.compactMap(\.string))
      order.removeAll { gone.contains($0) }
      for path in gone { entities[path] = nil }
    }
    if case .array(let upserted)? = fields["upsert"] {
      for entity in upserted {
        guard let path = path(entity) else { continue }
        if entities[path] == nil { order.append(path) }
        entities[path] = entity
      }
    }
  }
}
