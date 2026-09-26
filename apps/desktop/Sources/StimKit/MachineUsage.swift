import Foundation

/// The `machine` section of `stim status --json`: what uses the Mac's CPU and memory now, each process counted in
/// exactly one owner. Absent from a `stim` that predates it, null when nothing runs.
public struct MachineUsage: Decodable, Hashable, Sendable {
  public var owners: [MachineOwner]

  public init(owners: [MachineOwner]) {
    self.owners = owners
  }
}

public struct MachineOwner: Decodable, Hashable, Sendable {
  public enum Kind: String, Decodable, Sendable {
    case simulator, emulator, metro, build, browser, server, shared, other

    public init(from decoder: Decoder) throws {
      self = Kind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .other
    }
  }

  public var kind: Kind
  public var name: String
  public var workspace: String?
  public var slot: String?
  public var id: String?
  public var owned: Bool
  /// `ps` %CPU summed over the owner's processes; 100 is one core.
  public var cpuPercent: Double
  /// Summed resident set size, which counts shared pages once per process.
  public var residentMb: Int
  public var processes: Int

  public init(
    kind: Kind, name: String, workspace: String? = nil, slot: String? = nil, id: String? = nil, owned: Bool = false,
    cpuPercent: Double = 0, residentMb: Int = 0, processes: Int = 1
  ) {
    self.kind = kind
    self.name = name
    self.workspace = workspace
    self.slot = slot
    self.id = id
    self.owned = owned
    self.cpuPercent = cpuPercent
    self.residentMb = residentMb
    self.processes = processes
  }

  /// A stable identity across refreshes.
  public var key: String { "\(kind.rawValue):\(workspace ?? ""):\(slot ?? ""):\(id ?? name)" }

  /// The command that stops this owner, run from its workspace: `stim stop --slot <slot>` for a workspace's owned
  /// simulator or emulator, `stim stop` for its Metro. Nil for everything else, and always for what Stim does not own.
  public var stopCommand: StimCommand? {
    guard owned, let workspace else { return nil }
    switch kind {
    case .simulator, .emulator: return StimCommand(["stop", "--slot", slot ?? "default"], cwd: workspace)
    case .metro: return StimCommand(["stop"], cwd: workspace)
    default: return nil
    }
  }

  /// "Shut down" for a device, "Stop" for Metro, matching `stopCommand`.
  public var stopTitle: String? {
    guard stopCommand != nil else { return nil }
    return kind == .metro ? "Stop" : "Shut down"
  }
}

extension MachineUsage {
  /// The owners by resident memory, then CPU, then name. Memory moves slowly, so rows keep their place between
  /// refreshes and a Stop or Shut down button stays under the pointer; CPU swings each refresh.
  public var ranked: [MachineOwner] {
    owners.sorted {
      ($0.residentMb, $0.cpuPercent, $1.name) > ($1.residentMb, $1.cpuPercent, $0.name)
    }
  }

  public var cpuPercent: Double { owners.reduce(0) { $0 + $1.cpuPercent } }
}
