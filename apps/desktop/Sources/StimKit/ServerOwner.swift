import Foundation

/// The stim-server that reports a workspace and everything in it: its devices, builds and hosted sessions. A paired
/// server is keyed by `PairedServer.id`, the fingerprint of the key pinned at pairing, never by `hello.server.id`,
/// which the server supplies itself.
public enum ServerOwner: Hashable, Sendable {
  /// This Mac's own server.
  case local
  /// Another machine's server, by `PairedServer.id`.
  case paired(String)

  public var isLocal: Bool { self == .local }

  /// Prefixes an identifier so two servers' records never share one; a local identifier is unchanged.
  public func scoped(_ id: String) -> String {
    switch self {
    case .local: return id
    case .paired(let pairing): return "paired:\(pairing):\(id)"
    }
  }
}

/// A workspace path as one server reports it. Two servers can report the same path, such as two Macs that share a
/// username.
public struct WorkspaceKey: Hashable, Identifiable, Sendable {
  public var owner: ServerOwner
  /// The path on the owner's machine.
  public var path: String

  public init(owner: ServerOwner, path: String) {
    self.owner = owner
    self.path = path
  }

  public var id: String { owner.scoped(path) }

  /// The path to give a local file, process, git or Finder API; nil for a paired server's workspace, whose path names a
  /// directory on another machine even when the same path exists here.
  public var localPath: String? { owner.isLocal ? path : nil }
}

/// A workspace together with the server that reports it.
public struct OwnedWorkspace: Hashable, Identifiable, Sendable {
  public var owner: ServerOwner
  public var workspace: Workspace

  public init(owner: ServerOwner, workspace: Workspace) {
    self.owner = owner
    self.workspace = workspace
  }

  public var key: WorkspaceKey { WorkspaceKey(owner: owner, path: workspace.path) }
  public var id: String { key.id }

  public var devices: [OwnedDevice] { workspace.devices.map { OwnedDevice(owner: owner, ref: $0) } }
}

/// A device together with the server that reports it. Only a device of this Mac's server can name a simulator,
/// emulator or window here: a paired server's own simulator also has no hosting machine, but its UDID belongs to
/// another Mac.
public struct OwnedDevice: Hashable, Identifiable, Sendable {
  public var owner: ServerOwner
  public var ref: DeviceRef

  public init(owner: ServerOwner, ref: DeviceRef) {
    self.owner = owner
    self.ref = ref
  }

  public var id: String { owner.scoped(ref.id) }

  /// The UDID of a simulator on this Mac, for CoreSimulator; nil for any device a paired server reports.
  public var localSimulatorUDID: String? { owner.isLocal ? ref.localSimulatorUDID : nil }

  /// The serial of an emulator on this Mac, for its gRPC endpoint; nil for any device a paired server reports.
  public var localEmulatorSerial: String? { owner.isLocal ? ref.localEmulatorSerial : nil }

  /// The key screen changes on this Mac are recorded under; nil for any device a paired server reports.
  public var activityKey: String? { owner.isLocal ? ref.activityKey : nil }
}

extension OwnedDevice {
  /// Whether Stim Desktop can send this device clicks and keys: a simulator, emulator or browser it drives on this
  /// Mac, or a device whose owning server streams it, either its own or one it hosts on another Mac.
  public var isInteractive: Bool {
    switch ref {
    case .ios(_, let sim):
      return !sim.physical
        && (ref.hostedIos != nil
          ? ref.state != "stopped" : ref.isRunning && (localSimulatorUDID != nil || !owner.isLocal))
    case .android(_, let avd):
      return ref.hostedMachine != nil
        ? ref.state != "stopped"
        : ref.isRunning && (avd.owned || avd.physical) && (localEmulatorSerial != nil || !owner.isLocal)
    case .web(let browser):
      return owner.isLocal && browser.running && browser.cdpEndpoint != nil && browser.targetId != nil
    case .macos: return ref.hostedMachine != nil && ref.state != "stopped"
    case .remote: return false
    }
  }

  /// What a tile shows of a device stim-server streams. `server` names a paired owner in its messages.
  public func screen(link: ServerLink, now: Date, server: String) -> PhysicalScreen {
    owner.isLocal
      ? PhysicalScreen(device: ref, link: link, now: now)
      : PhysicalScreen(pairedDevice: ref, server: server, link: link, now: now)
  }

  /// Whether the viewer offers Control: always for a simulator or emulator this Mac drives itself, and otherwise
  /// only when the server that streams the device lets this Mac control it.
  public func offersControl(link: ServerLink, now: Date) -> Bool {
    guard isInteractive else { return false }
    if owner.isLocal, !ref.isPhysical, ref.hostedMachine == nil { return true }
    return screen(link: link, now: now, server: "").canControl
  }
}
