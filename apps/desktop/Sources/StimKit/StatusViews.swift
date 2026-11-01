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
    /// The workspaces and worktrees exceed `Limits`; they were dropped and `hasWorkspaces` is false.
    case overflow
  }

  /// The most workspaces and worktrees together, and the most bytes of their JSON, the views keep.
  public struct Limits: Equatable, Sendable {
    public var entities: Int
    public var bytes: Int

    public init(entities: Int, bytes: Int) {
      self.entities = entities
      self.bytes = bytes
    }
  }

  private struct Entities {
    var order: [String] = []
    var byPath: [String: JSONValue] = [:]
    var sizes: [String: Int] = [:]
    var bytes = 0

    mutating func set(_ entity: JSONValue, at path: String, measuring: Bool) {
      if byPath[path] == nil { order.append(path) }
      byPath[path] = entity
      guard measuring else { return }
      bytes -= sizes[path] ?? 0
      let size = (try? JSONEncoder().encode(entity).count) ?? 0
      sizes[path] = size
      bytes += size
    }

    mutating func remove(_ gone: Set<String>) {
      order.removeAll { gone.contains($0) }
      for path in gone {
        byPath[path] = nil
        bytes -= sizes.removeValue(forKey: path) ?? 0
      }
    }
  }

  private let limits: Limits?
  private var workspaces = Entities()
  private var worktrees = Entities()
  private var nextSeq: Int?
  public private(set) var archivedSummary: JSONValue?
  private var machine: [String: JSONValue] = [:]
  private var archives: [JSONValue]?
  private var archivedUsage: JSONValue?
  private var details: [String: JSONValue] = [:]

  /// Views that hold at most `limits` of workspaces and worktrees, or any number for nil.
  public init(limits: Limits? = nil) { self.limits = limits }

  /// Starts fresh workspace views while retaining machine and archive values until their replacements arrive.
  public init(retainingMachineAndArchives previous: StatusViews) {
    limits = previous.limits
    machine = previous.machine
    archives = previous.archives
    archivedUsage = previous.archivedUsage
  }

  /// Whether a `workspaces` snapshot arrived, so `payload()` lists the workspaces.
  public var hasWorkspaces: Bool { nextSeq != nil }

  /// Applies one `workspaces` event.
  public mutating func applyWorkspaces(_ fields: [String: JSONValue]) -> Outcome {
    guard let number = fields["seq"]?.number else { return .unchanged }
    guard let seq = ServerProtocol.exactInteger(number) else { return .gap }
    if case .object(let snapshot)? = fields["snapshot"] {
      workspaces = Entities()
      worktrees = Entities()
      Self.apply(upsert: snapshot["workspaces"], to: &workspaces, measuring: limits != nil)
      Self.apply(upsert: snapshot["worktrees"], to: &worktrees, measuring: limits != nil)
      archivedSummary = snapshot["archived"]
      nextSeq = seq + 1
      return exceeded() ? dropWorkspaces() : .changed
    }
    guard seq == nextSeq else { return .gap }
    nextSeq = seq + 1
    Self.apply(fields["workspaces"], to: &workspaces, measuring: limits != nil)
    Self.apply(fields["worktrees"], to: &worktrees, measuring: limits != nil)
    if let archived = fields["archived"] { archivedSummary = archived }
    return exceeded() ? dropWorkspaces() : .changed
  }

  private func exceeded() -> Bool {
    guard let limits else { return false }
    return workspaces.order.count + worktrees.order.count > limits.entities
      || workspaces.bytes + worktrees.bytes > limits.bytes
  }

  private mutating func dropWorkspaces() -> Outcome {
    workspaces = Entities()
    worktrees = Entities()
    archivedSummary = nil
    nextSeq = nil
    return .overflow
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
      "environments": .array(workspaces.order.compactMap { details[$0] ?? workspaces.byPath[$0] }),
      "unprovisionedWorktrees": .array(worktrees.order.compactMap { worktrees.byPath[$0] }),
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

  private static func apply(_ delta: JSONValue?, to entities: inout Entities, measuring: Bool) {
    guard case .object(let fields)? = delta else { return }
    if case .array(let removed)? = fields["remove"] {
      entities.remove(Set(removed.compactMap(\.string)))
    }
    apply(upsert: fields["upsert"], to: &entities, measuring: measuring)
  }

  private static func apply(upsert list: JSONValue?, to entities: inout Entities, measuring: Bool) {
    guard case .array(let upserted)? = list else { return }
    for entity in upserted {
      guard let path = path(entity) else { continue }
      entities.set(entity, at: path, measuring: measuring)
    }
  }
}
