import Foundation

/// The payload printed by `stim status --json`.
public struct StatusPayload: Decodable, Sendable {
  public var environments: [Workspace]
  public var capacity: Capacity?
  public var unprovisionedWorktrees: [UnprovisionedWorktree]?
}

public struct Capacity: Decodable, Sendable {
  public var liveCount: Int
  public var committedMb: Int
  public var totalMemoryMb: Int
  public var overCapacity: Bool
}

public struct UnprovisionedWorktree: Decodable, Hashable, Sendable {
  public var path: String
  public var branch: String?
  /// The repository's main checkout, or its git directory when it is bare.
  public var repository: String?
}

public struct Workspace: Decodable, Identifiable, Hashable, Sendable {
  public var path: String
  public var live: Bool
  public var memoryMb: Int?
  public var warnings: [String]
  public var ios: IosDevice?
  public var android: AndroidDevice?
  public var metro: Metro?
  public var supervisor: Supervisor?
  public var logs: Logs?
  public var slots: [Slot]?
  public var remoteDevices: [RemoteDevice]?
  public var build: Build?
  public var worktree: WorktreeInfo?

  public var id: String { path }

  /// The workspace's default devices followed by each named slot's devices.
  public var devices: [DeviceRef] {
    var out: [DeviceRef] = []
    if let ios { out.append(.ios(slot: DeviceRef.defaultSlot, ios)) }
    if let android { out.append(.android(slot: DeviceRef.defaultSlot, android)) }
    for slot in slots ?? [] {
      if let ios = slot.ios { out.append(.ios(slot: slot.slot, ios)) }
      if let android = slot.android { out.append(.android(slot: slot.slot, android)) }
    }
    for remote in remoteDevices ?? [] { out.append(.remote(remote)) }
    return out
  }

  /// The running build that targets this local device's platform and slot. The status record does not say
  /// whether a run targets a remote session, so remote devices get none.
  public func runningBuild(for device: DeviceRef) -> Build? {
    if case .remote = device { return nil }
    guard let build, build.isRunning, build.platform == device.platform, build.slot == device.slot else { return nil }
    return build
  }

  public var names: PathNames { PathNames(path: path) }
}

/// The git worktree that holds a workspace.
public struct WorktreeInfo: Decodable, Hashable, Sendable {
  public var path: String
  public var branch: String?
  public var repository: String?
}

public struct Slot: Decodable, Hashable, Sendable {
  public var slot: String
  public var ios: IosDevice?
  public var android: AndroidDevice?
}

public struct IosDevice: Decodable, Hashable, Sendable {
  public var name: String
  public var udid: String
  public var owned: Bool
  public var state: String
  public var activity: DeviceActivity?
}

public struct AndroidDevice: Decodable, Hashable, Sendable {
  public var name: String
  public var owned: Bool
  public var physical: Bool
  public var serial: String?
  public var state: String
  public var activity: DeviceActivity?
}

/// A billable remote session recorded for the workspace, such as an EAS Simulator.
public struct RemoteDevice: Decodable, Hashable, Sendable {
  public var platform: String?
  public var backend: String
  public var sessionId: String
  public var state: String
  public var startedAt: String?
  public var webPreviewUrl: String?
}

public struct Metro: Decodable, Hashable, Sendable {
  public var port: Int
  public var running: Bool
  public var pid: Int?
}

public struct Supervisor: Decodable, Hashable, Sendable {
  public var pid: Int?
  public var mode: String?
  public var startedAt: String?
  public var healthy: Bool?
}

public struct Logs: Decodable, Hashable, Sendable {
  public var dir: String
  public var errorsSinceMarker: Int?
}
