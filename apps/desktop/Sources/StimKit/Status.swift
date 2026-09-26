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
  public var git: WorktreeGit?

  public var names: PathNames { PathNames(path: path, branch: branch, worktree: path) }
}

public struct Workspace: Decodable, Identifiable, Hashable, Sendable {
  public var path: String
  public var live: Bool
  public var memoryMb: Int?
  public var warnings: [String]
  /// Absent from a `stim` that reports only `warnings`.
  public var issues: [StatusIssue]?
  public var ios: IosDevice?
  public var android: AndroidDevice?
  public var metro: Metro?
  public var supervisor: Supervisor?
  public var logs: Logs?
  public var slots: [Slot]?
  public var remoteDevices: [RemoteDevice]?
  public var build: Build?
  public var lastBuilds: LastBuilds?
  /// Each platform's last runs, newest first; absent from an older `stim`.
  public var builds: BuildHistory?
  public var worktree: WorktreeInfo?
  /// The project Stim Desktop resolved for the workspace; not part of the payload.
  public var project: Project?

  enum CodingKeys: String, CodingKey {
    case path, live, memoryMb, warnings, issues, ios, android, metro, supervisor, logs, slots, remoteDevices, build
    case lastBuilds, builds, worktree
  }

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

  /// `devices` with driven devices first, then other running ones, then stopped ones, by slot inside each group.
  public var orderedDevices: [DeviceRef] {
    func rank(_ device: DeviceRef) -> Int {
      device.isRunning ? (device.activity?.state == "driven" ? 0 : 1) : 2
    }
    return devices.enumerated().sorted { a, b in
      let (ra, rb) = (rank(a.element), rank(b.element))
      if ra != rb { return ra < rb }
      if a.element.slot != b.element.slot { return a.element.slot < b.element.slot }
      return a.offset < b.offset
    }.map(\.element)
  }

  /// The running build that targets this local device's platform and slot. The status record does not say
  /// whether a run targets a remote session, so remote devices get none.
  public func runningBuild(for device: DeviceRef) -> Build? {
    if case .remote = device { return nil }
    guard let build, build.isRunning, build.platform == device.platform, build.slot == device.slot else { return nil }
    return build
  }

  public var names: PathNames {
    PathNames(path: path, branch: worktree?.branch, worktree: worktree?.path, project: project)
  }
}

/// One thing in a workspace that needs the user; `remedy` is a command to run from `workspace`.
public struct StatusIssue: Decodable, Hashable, Sendable {
  public var code: String
  public var severity: String
  public var message: String
  public var remedy: String
  public var workspace: String
  public var slot: String?
}

/// The git worktree that holds a workspace.
public struct WorktreeInfo: Decodable, Hashable, Sendable {
  public var path: String
  public var branch: String?
  public var repository: String?
  public var git: WorktreeGit?
}

/// A worktree's `git status`, as `stim status --json` reports it. `ahead` and `behind` are nil without an upstream.
public struct WorktreeGit: Decodable, Hashable, Sendable {
  public var changed: Int
  public var untracked: Int
  public var upstream: String?
  public var ahead: Int?
  public var behind: Int?
  public var mergedInto: String?

  public init(
    changed: Int, untracked: Int, upstream: String? = nil, ahead: Int? = nil, behind: Int? = nil,
    mergedInto: String? = nil
  ) {
    self.changed = changed
    self.untracked = untracked
    self.upstream = upstream
    self.ahead = ahead
    self.behind = behind
    self.mergedInto = mergedInto
  }

  /// Changed and untracked files together: what a commit would still have to pick up.
  public var uncommitted: Int { changed + untracked }

  /// `\u{2191}2 \u{2193}1` for commits ahead of and behind the upstream, or nil when level with it.
  public var arrows: String? {
    let parts = [(ahead ?? 0) > 0 ? "\u{2191}\(ahead!)" : nil, (behind ?? 0) > 0 ? "\u{2193}\(behind!)" : nil]
      .compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: " ")
  }

  /// Whether the indicator shows anything: a clean branch level with its upstream shows nothing.
  public var isNotable: Bool { uncommitted > 0 || arrows != nil || mergedInto != nil }

  /// A sentence for help text and accessibility.
  public var summary: String {
    var parts: [String] = []
    if uncommitted > 0 { parts.append("\(uncommitted) uncommitted \(uncommitted == 1 ? "change" : "changes")") }
    if let ahead, ahead > 0 { parts.append(unpushedLabel(ahead)) }
    if let behind, behind > 0 { parts.append(behindLabel(behind)) }
    if let mergedInto { parts.append("merged into \(mergedInto)") }
    return parts.isEmpty ? "Clean" : parts.joined(separator: ", ")
  }

  public func unpushedLabel(_ count: Int) -> String {
    "\(Self.commits(count)) not pushed" + (upstream.map { " to \($0)" } ?? "")
  }

  public func behindLabel(_ count: Int) -> String {
    "\(Self.commits(count)) behind \(upstream ?? "the upstream")"
  }

  private static func commits(_ count: Int) -> String { "\(count) \(count == 1 ? "commit" : "commits")" }
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
  public var app: AppProcess?

  enum CodingKeys: String, CodingKey { case name, udid, owned, state, activity, app }

  public init(name: String, udid: String, owned: Bool, state: String, activity: DeviceActivity? = nil) {
    self.name = name
    self.udid = udid
    self.owned = owned
    self.state = state
    self.activity = activity
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    udid = try c.decode(String.self, forKey: .udid)
    name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Missing simulator"
    owned = try c.decode(Bool.self, forKey: .owned)
    state = try c.decode(String.self, forKey: .state)
    activity = try c.decodeIfPresent(DeviceActivity.self, forKey: .activity)
    app = try c.decodeIfPresent(AppProcess.self, forKey: .app)
  }
}

/// Whether the workspace's app process runs on a device now: `state` is "running", "stopped", or "unknown" when
/// `stim status` could not read the process list. Absent from a `stim` that does not report it.
public struct AppProcess: Decodable, Hashable, Sendable {
  public var id: String
  public var state: String
}

public struct AndroidDevice: Decodable, Hashable, Sendable {
  public var name: String
  public var owned: Bool
  public var physical: Bool
  public var serial: String?
  public var state: String
  public var deviceProfile: String?
  public var activity: DeviceActivity?
  public var app: AppProcess?
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
