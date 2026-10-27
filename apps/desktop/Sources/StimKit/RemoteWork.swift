import Foundation

/// Work a server controls that runs on another machine: a device hosted there, or a build offloaded there.
public struct RemoteWork: Hashable, Identifiable, Sendable {
  public enum Kind: Hashable, Sendable {
    case hostedDevice(OwnedDevice)
    case offloadedBuild(Build)
  }

  public var kind: Kind
  /// The workspace it belongs to, on the server that controls it.
  public var workspace: WorkspaceKey
  public var workspaceTitle: String
  /// Where it runs, as `machineName` shows a machine.
  public var host: String

  public var owner: ServerOwner { workspace.owner }

  public var id: String {
    switch kind {
    case .hostedDevice(let device): return device.id
    case .offloadedBuild(let build): return workspace.owner.scoped("build:\(workspace.path):\(build.key)")
    }
  }

  /// Every hosted device and offloaded build in `workspaces`, in their order. A hosted session that more than one
  /// server reports shows once, under the first of them.
  public static func list(_ workspaces: [OwnedWorkspace]) -> [RemoteWork] {
    var sessions = Set<String>()
    var work: [RemoteWork] = []
    for owned in workspaces {
      let title = owned.workspace.names.title
      for device in owned.devices {
        guard let machine = device.ref.hostedMachine, let session = device.ref.hostedSession,
          sessions.insert(session).inserted
        else { continue }
        work.append(
          RemoteWork(kind: .hostedDevice(device), workspace: owned.key, workspaceTitle: title, host: machineName(machine)))
      }
      if let build = owned.workspace.build, build.isRunning, case .remote(let host, _, _, _) = build.placement {
        work.append(
          RemoteWork(kind: .offloadedBuild(build), workspace: owned.key, workspaceTitle: title, host: machineName(host)))
      }
    }
    return work
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

/// A paired server's sidebar rows: its workspaces grouped as `options` groups this Mac's, with `hidden`, the paths
/// hidden on that server, as the only hidden workspaces. This Mac's hidden projects and workspaces name local paths, so
/// they never hide a paired server's workspace that shares one.
public func pairedSidebarTrees(environments: [Workspace], options: SidebarOptions, hidden: Set<String>) -> [ProjectTree] {
  var paired = options
  paired.hiddenProjects = []
  paired.hiddenWorkspaces = HiddenWorkspaces(paths: hidden)
  let projects = Dictionary(
    environments.map { ($0.path, $0.project ?? Project(fallbackFor: $0.path)) }, uniquingKeysWith: { first, _ in first })
  return sidebarTrees(
    environments: environments, unprovisioned: [], project: { projects[$0] ?? Project(fallbackFor: $0) },
    options: paired)
}
