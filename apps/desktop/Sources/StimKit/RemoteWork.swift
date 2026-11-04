import Foundation

/// What runs on another machine: a device hosted there, or a build offloaded there.
public enum RemoteWorkKind: Hashable, Sendable {
  case hostedDevice(OwnedDevice)
  case offloadedBuild(Build)

  public var isHostedDevice: Bool {
    if case .hostedDevice = self { return true }
    return false
  }
}

/// This machine's own work placed on a remote machine: it belongs to this machine's Stim home and runs there. Work a
/// paired server placed is `ForeignWork`; the two never share a value, a list or a sentence.
public struct PlacedWork: Hashable, Identifiable, Sendable {
  public var kind: RemoteWorkKind
  /// The workspace's path on this machine.
  public var workspace: String
  public var workspaceTitle: String
  /// The machine it runs on, as the device or build reports it.
  public var machine: String

  public var id: String { identity(of: kind, workspace: workspace, owner: .local) }

  /// The machine's name without its port.
  public var host: String { machineName(machine) }

  /// The badge a workspace row carries.
  public var badge: String { "on \(host)" }

  /// Whether it runs on `entry`, a `remote.machines` entry.
  public func isOn(_ entry: String) -> Bool { isSameMachine(entry, machine) }

  public var title: String { workTitle(kind, workspaceTitle: workspaceTitle) }

  public func place(now: Date) -> String {
    switch kind {
    case .hostedDevice: return "running on \(host)"
    case .offloadedBuild(let build):
      return ["building on \(host)", build.remote(at: now)?.phase].compactMap { $0 }.joined(separator: " \u{00B7} ")
    }
  }

  /// Every hosted device and offloaded build this machine's workspaces place on a remote machine, in their order. A
  /// session that a paired server also reports shows once, here.
  public static func list(_ workspaces: [OwnedWorkspace]) -> [PlacedWork] {
    remoteWork(in: workspaces).filter { $0.owner.isLocal }.map {
      PlacedWork(kind: $0.kind, workspace: $0.workspace, workspaceTitle: $0.workspaceTitle, machine: $0.machine)
    }
  }
}

/// Work a paired server controls that runs on another machine: it belongs to that server's Stim home, and this machine
/// only views it.
public struct ForeignWork: Hashable, Identifiable, Sendable {
  public var kind: RemoteWorkKind
  /// The `PairedServer.id` of the server that controls it.
  public var server: String
  /// The workspace's path on that server.
  public var workspace: String
  public var workspaceTitle: String
  /// The machine it runs on, as the device or build reports it.
  public var machine: String

  public var id: String { identity(of: kind, workspace: workspace, owner: .paired(server)) }

  public var host: String { machineName(machine) }

  public var title: String { workTitle(kind, workspaceTitle: workspaceTitle) }

  /// Where it runs, named by the server that placed it.
  public func place(serverName: String, now: Date) -> String {
    switch kind {
    case .hostedDevice: return "\(serverName) runs it on \(host)"
    case .offloadedBuild(let build):
      return ["\(serverName) builds it on \(host)", build.remote(at: now)?.phase].compactMap { $0 }
        .joined(separator: " \u{00B7} ")
    }
  }

  /// Every hosted device and offloaded build the paired server `server` places on a machine, in their order.
  public static func list(_ workspaces: [OwnedWorkspace], server: String) -> [ForeignWork] {
    remoteWork(in: workspaces).compactMap { work in
      guard work.owner == .paired(server) else { return nil }
      return ForeignWork(
        kind: work.kind, server: server, workspace: work.workspace, workspaceTitle: work.workspaceTitle,
        machine: work.machine)
    }
  }
}

extension OwnedDevice {
  /// What a workspace row says of a device that runs on another machine, or nil when it runs here.
  public var placementBadge: PlacementBadge? {
    ref.placement.map { PlacementBadge(machine: $0.machine, reason: $0.reason, owned: owner.isLocal) }
  }
}

/// A workspace row's note that a device runs on another machine. A device this machine's server placed reads "on
/// mini"; one a paired server placed reads "theirs, on mini", so the two never look alike in the sidebar.
public struct PlacementBadge: Hashable, Sendable {
  public var machine: String
  public var reason: String?
  /// Whether the work belongs to this machine's Stim home.
  public var owned: Bool

  public var text: String { owned ? "on \(machine)" : "theirs, on \(machine)" }

  public var accessibilityLabel: String { owned ? "Yours, running on \(machine)" : "Theirs, running on \(machine)" }
}

private struct ScannedWork {
  var owner: ServerOwner
  var kind: RemoteWorkKind
  var workspace: String
  var workspaceTitle: String
  var machine: String
}

/// Every hosted device and offloaded build in `workspaces`, in their order. A hosted session that more than one server
/// reports counts once, under the first of them.
private func remoteWork(in workspaces: [OwnedWorkspace]) -> [ScannedWork] {
  var sessions = Set<String>()
  var work: [ScannedWork] = []
  for owned in workspaces {
    let title = owned.workspace.names.title
    for device in owned.devices {
      guard let machine = device.ref.hostedMachine, let session = device.ref.hostedSession,
        sessions.insert(session).inserted
      else { continue }
      work.append(
        ScannedWork(
          owner: owned.owner, kind: .hostedDevice(device), workspace: owned.workspace.path, workspaceTitle: title,
          machine: machine))
    }
    if let build = owned.workspace.build, build.isRunning, case .remote(let host, _, _, _) = build.placement {
      work.append(
        ScannedWork(
          owner: owned.owner, kind: .offloadedBuild(build), workspace: owned.workspace.path, workspaceTitle: title,
          machine: host))
    }
  }
  return work
}

private func identity(of kind: RemoteWorkKind, workspace: String, owner: ServerOwner) -> String {
  switch kind {
  case .hostedDevice(let device): return device.id
  case .offloadedBuild(let build): return owner.scoped("build:\(workspace):\(build.key)")
  }
}

private func workTitle(_ kind: RemoteWorkKind, workspaceTitle: String) -> String {
  switch kind {
  case .hostedDevice(let device): return "\(device.ref.model) \u{00B7} \(workspaceTitle)"
  case .offloadedBuild(let build): return "\(platformName(build.platform)) build \u{00B7} \(workspaceTitle)"
  }
}

extension DeviceRef {
  var hostedSession: String? {
    switch self {
    case .ios(_, let d): return d.host.map { "ios:\($0.machine):\($0.session)" }
    case .android(_, let d): return d.host.map { "android:\($0.machine):\($0.session)" }
    case .macos(let d): return d.host.map { "macos:\($0.machine):\($0.session)" }
    case .remote, .web: return nil
    }
  }
}

/// A paired server's sidebar rows: its workspaces grouped as `options` groups this machine's, with `hidden`, the paths
/// hidden on that server, as the only hidden workspaces. This machine's hidden projects and workspaces name local paths,
/// so they never hide a paired server's workspace that shares one.
public func pairedSidebarTrees(environments: [Workspace], options: SidebarOptions, hidden: Set<String>) -> [ProjectTree] {
  var paired = options
  paired.hiddenProjects = []
  paired.hiddenWorkspaces = HiddenWorkspaces(paths: hidden)
  let projects = Dictionary(
    environments.map { ($0.path, $0.project ?? Project(fallbackFor: $0.path)) }, uniquingKeysWith: { first, _ in first })
  return sidebarTrees(
    environments: environments.map { app in
      var localMask = app
      localMask.hidden = nil
      return localMask
    }, unprovisioned: [], project: { projects[$0] ?? Project(fallbackFor: $0) }, options: paired)
}
