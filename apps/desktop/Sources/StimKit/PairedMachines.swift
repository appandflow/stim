import Foundation

/// Which machines' workspaces Active Workspaces, the Overview and Builds list.
public enum MachineScope: String, CaseIterable, Sendable {
  case all, thisMac

  public var title: String { self == .all ? "All Machines" : "This Mac" }
}

/// A paired machine as the screens that span machines show it: its name, what this Mac may do there, and the
/// workspaces its server reports. A machine that is not delivering has none, so no screen shows its last status.
public struct PairedMachine: Identifiable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var canControl: Bool
  public var isAvailable: Bool
  public var workspaces: [Workspace]

  public var owner: ServerOwner { .paired(id) }
  public var accessTitle: String { canControl ? "View and Control" : "View Only" }

  /// The pairings in `entries` with their workspaces. `status` returns what the pairing's server last reported and
  /// whether its feed delivers now. A pairing is available only while its connection is open and its feed delivers,
  /// which an unreachable, refused or revoked pairing is not; its workspaces are dropped instead of shown stale.
  public static func list(
    entries: [PairedServers.Entry], status: (String) -> (payload: StatusPayload?, delivering: Bool)?
  ) -> [PairedMachine] {
    entries.compactMap { entry in
      guard let pairing = entry.pairing else { return nil }
      let reported = status(entry.id)
      let available = entry.connection == .open && reported?.delivering == true && reported?.payload != nil
      return PairedMachine(
        id: entry.id, name: pairing.name.isEmpty ? "Paired machine" : pairing.name,
        canControl: pairing.capabilities.contains("control"), isAvailable: available,
        workspaces: available ? reported?.payload?.environments ?? [] : [])
    }
  }
}

extension WallCard {
  /// What a card says about the machine that owns its workspace; nil on this Mac's cards.
  public struct Machine: Equatable, Sendable {
    public var name: String
    public var accessTitle: String
    public var canControl: Bool
  }

  /// A card for each active workspace of `machine`, ordered by path. A paired workspace opens on its own screen, so
  /// each card holds one workspace, never a worktree's apps together.
  public static func cards(machine: PairedMachine) -> [WallCard] {
    machine.workspaces.filter(\.isActive).sorted { $0.path < $1.path }.flatMap { cards(environments: [$0]) }.map {
      var card = $0
      card.owner = machine.owner
      card.machine = Machine(name: machine.name, accessTitle: machine.accessTitle, canControl: machine.canControl)
      return card
    }
  }

  /// This Mac's `local` cards, then each available machine's when `scope` is `all`.
  public static func merged(local: [WallCard], machines: [PairedMachine], scope: MachineScope) -> [WallCard] {
    scope == .thisMac ? local : local + machines.filter(\.isAvailable).flatMap { cards(machine: $0) }
  }
}

/// A build in progress and where its workspace lives, for the Builds screen.
public struct RunningBuild: Identifiable, Hashable, Sendable {
  public var workspace: WorkspaceKey
  public var title: String
  /// The paired machine's name; nil for this Mac.
  public var machine: String?
  public var build: Build

  public var id: String { workspace.owner.scoped("build:\(workspace.path):\(build.key)") }

  /// The running builds of `local`, then of each available machine's workspaces when `scope` is `all`.
  public static func list(local: [Workspace], machines: [PairedMachine], scope: MachineScope) -> [RunningBuild] {
    func running(_ workspaces: [Workspace], owner: ServerOwner, machine: String?) -> [RunningBuild] {
      workspaces.compactMap { workspace in
        guard let build = workspace.build, build.isRunning else { return nil }
        return RunningBuild(
          workspace: WorkspaceKey(owner: owner, path: workspace.path), title: workspace.names.title, machine: machine,
          build: build)
      }
    }
    let own = running(local, owner: .local, machine: nil)
    guard scope == .all else { return own }
    return own + machines.filter(\.isAvailable).flatMap { running($0.workspaces, owner: $0.owner, machine: $0.name) }
  }
}

/// One step of a running build's phases.
public struct BuildPhaseStep: Equatable, Sendable {
  public enum State: Equatable, Sendable {
    case done, current, upcoming
  }

  public var phase: String
  public var state: State

  public var title: String {
    let words = phase.replacingOccurrences(of: "-", with: " ")
    return words.prefix(1).uppercased() + words.dropFirst()
  }
}

extension Build {
  /// The phases runs like this one go through, with the finished ones and the current one marked. Without planned
  /// phases it holds the current phase alone.
  public var phaseSteps: [BuildPhaseStep] {
    var names = (plannedPhases ?? []).map(\.phase)
    if !names.contains(phase) { names.append(phase) }
    let finished = Set((completedPhaseMs ?? [:]).keys)
    return names.map { name in
      BuildPhaseStep(phase: name, state: name == phase ? .current : finished.contains(name) ? .done : .upcoming)
    }
  }
}

/// What a machine runs, for the Overview.
public struct MachineTally: Identifiable, Equatable, Sendable {
  public var id: String
  public var name: String
  /// "View Only" or "View and Control" for a paired machine; nil for this Mac.
  public var access: String?
  public var isAvailable: Bool
  public var activeWorkspaces: Int
  public var builds: Int
  public var devices: Int

  init(id: String, name: String, access: String?, isAvailable: Bool, workspaces: [Workspace]) {
    self.id = id
    self.name = name
    self.access = access
    self.isAvailable = isAvailable
    activeWorkspaces = workspaces.filter(\.isActive).count
    builds = workspaces.filter { $0.build?.isRunning == true }.count
    devices = workspaces.reduce(0) { $0 + $1.devices.filter(\.isRunning).count }
  }

  /// This Mac first, then each paired machine; an unavailable one counts nothing. Empty without a paired machine,
  /// as there is nothing to compare This Mac with.
  public static func list(local: [Workspace], machines: [PairedMachine], scope: MachineScope) -> [MachineTally] {
    guard scope == .all, !machines.isEmpty else { return [] }
    return [MachineTally(id: "local", name: "This Mac", access: nil, isAvailable: true, workspaces: local)]
      + machines.map {
        MachineTally(id: $0.id, name: $0.name, access: $0.accessTitle, isAvailable: $0.isAvailable, workspaces: $0.workspaces)
      }
  }
}
