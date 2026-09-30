import Foundation

/// The payload printed by `stim status --json`.
public struct StatusPayload: Decodable, Sendable {
  public var environments: [Workspace]
  public var capacity: Capacity?
  public var unprovisionedWorktrees: [UnprovisionedWorktree]?
  public var machine: MachineUsage?
  /// The same payload as the oversight rules read it; nil when it does not decode as one.
  public var oversight: OversightStatus?

  enum CodingKeys: String, CodingKey { case environments, capacity, unprovisionedWorktrees, machine }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    environments = try c.decode([Workspace].self, forKey: .environments)
    capacity = try c.decodeIfPresent(Capacity.self, forKey: .capacity)
    unprovisionedWorktrees = try c.decodeIfPresent([UnprovisionedWorktree].self, forKey: .unprovisionedWorktrees)
    machine = try c.decodeIfPresent(MachineUsage.self, forKey: .machine)
    oversight = try? OversightStatus(from: decoder)
  }
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
  /// `warming`, `ready`, `live` or `idle`; absent from a `stim` that does not report lifecycle phases.
  public var phase: String?
  /// When the warm started (`warming`) or finished (`ready`).
  public var phaseSince: String?
  /// `refresh` or `copy` while `phase` is `warming`.
  public var warmStep: String?
  public var memoryMb: Int?
  /// How `memoryMb` was obtained; absent from an older `stim`, whose `memoryMb` is the estimate.
  public var memorySource: MemorySource?
  public var warnings: [String]
  /// Absent from a `stim` that reports only `warnings`.
  public var issues: [StatusIssue]?
  public var ios: IosDevice?
  public var android: AndroidDevice?
  public var web: WebBrowser?
  public var metro: Metro?
  public var supervisor: Supervisor?
  public var logs: Logs?
  public var slots: [Slot]?
  public var remoteDevices: [RemoteDevice]?
  /// The physical phones and tablets the workspace leases; absent from an older `stim` and when it leases none.
  public var physicalDevices: [PhysicalDevice]?
  public var build: Build?
  public var lastBuilds: LastBuilds?
  /// Each platform's last runs, newest first; absent from an older `stim`.
  public var builds: BuildHistory?
  public var worktree: WorktreeInfo?
  /// The coding-agent sessions working in the workspace, most recently active first; absent when none.
  public var agents: [AgentSession]?
  /// The sessions that stopped running in the workspace in the last 3 days, most recently ended first; absent when
  /// none and from an older `stim`.
  public var endedAgents: [AgentSession]?
  /// Whether stim-server may record this workspace's device screens; absent from a `stim` without replay.
  public var recording: Recording?
  /// Disk use as a status watcher last measured it; absent until one has, and from an older `stim`.
  public var disk: WorkspaceDisk?
  /// The project Stim Desktop resolved for the workspace; not part of the payload.
  public var project: Project?

  enum CodingKeys: String, CodingKey {
    case path, live, phase, phaseSince, warmStep, memoryMb, memorySource, warnings, issues, ios, android, web, metro
    case supervisor, logs, slots, remoteDevices, physicalDevices, build
    case lastBuilds, builds, worktree, recording
    case agents, endedAgents, disk
  }

  public struct Recording: Decodable, Hashable, Sendable {
    public var enabled: Bool
  }

  /// `recording.enabled` is false for this workspace, so it has no replay.
  public var replayOff: Bool { recording?.enabled == false }

  public var id: String { path }

  /// The physical footprint of the workspace's processes in bytes, when `stim status` measured it.
  public var footprintBytes: Int64? {
    guard memorySource == .footprint, let memoryMb else { return nil }
    return Int64(memoryMb) * 1_048_576
  }

  public var isWarming: Bool { phase == "warming" }

  /// A workspace `stim worktree warm` is preparing or has just prepared, before its first run.
  public var isSettingUp: Bool { isWarming || phase == "ready" }

  /// Whether the Live views show the workspace: something runs, a build runs, or it is being set up.
  public var isActive: Bool {
    live || build?.isRunning == true || isSettingUp || physicalDevices?.isEmpty == false
  }

  /// The workspace's default devices, its Stim-owned Chrome, each named slot's devices, then its leased physical
  /// devices.
  public var devices: [DeviceRef] {
    var out: [DeviceRef] = []
    if let ios { out.append(.ios(slot: DeviceRef.defaultSlot, ios)) }
    if let android { out.append(.android(slot: DeviceRef.defaultSlot, android)) }
    if let web { out.append(.web(web)) }
    for slot in slots ?? [] {
      if let ios = slot.ios { out.append(.ios(slot: slot.slot, ios)) }
      if let android = slot.android { out.append(.android(slot: slot.slot, android)) }
    }
    for device in physicalDevices ?? [] { out.append(device.ref) }
    for remote in remoteDevices ?? [] { out.append(.remote(remote)) }
    return out
  }

  /// `devices` running first, then iOS, Android, Web, physical and remote devices, then by slot. The order never
  /// depends on activity or drivers, so a device keeps its place while tools attach and detach.
  public var orderedDevices: [DeviceRef] {
    func rank(_ device: DeviceRef) -> Int {
      if case .remote = device { return 4 }
      if device.isPhysical { return 3 }
      return ["ios": 0, "android": 1, "web": 2][device.platform] ?? 4
    }
    return devices.enumerated().sorted { a, b in
      if a.element.isRunning != b.element.isRunning { return a.element.isRunning }
      let (ra, rb) = (rank(a.element), rank(b.element))
      if ra != rb { return ra < rb }
      let slots = a.element.slot.localizedCompare(b.element.slot)
      if slots != .orderedSame { return slots == .orderedAscending }
      return a.offset < b.offset
    }.map(\.element)
  }

  /// The running build that targets this local device's platform and slot. The status record does not say
  /// whether a run targets a remote session, so remote devices get none.
  public func runningBuild(for device: DeviceRef) -> Build? {
    if case .remote = device { return nil }
    if device.isPhysical { return nil }
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
  /// The branch's pull request as Stim last asked GitHub; nil when it has none or `stim` did not say.
  public var pullRequest: PullRequestFacts?
}

/// `stim status --json` `worktree.pullRequest`; `checks` counts the head commit's checks.
public struct PullRequestFacts: Decodable, Hashable, Sendable {
  public struct Checks: Decodable, Hashable, Sendable {
    public var passing: Int
    public var failing: Int
    public var pending: Int
  }

  public var number: Int
  public var url: String
  public var title: String
  /// `open`, `draft`, `merged` or `closed`.
  public var state: String
  public var checks: Checks?
  public var reviewDecision: String?
  public var checkedAt: String?
}

/// `worktreeBytes` is the git worktree folder with node_modules, `nodeModulesBytes` is part of it, and `buildBytes`
/// is Stim's own folder for the workspace.
public struct WorkspaceDisk: Decodable, Hashable, Sendable {
  public var worktreeBytes: Double?
  public var nodeModulesBytes: Double?
  public var buildBytes: Double?
  public var measuredAt: String?
}

/// A simulator's data folder or an emulator's AVD folder, as a status watcher last measured it.
public struct DeviceDisk: Decodable, Hashable, Sendable {
  public var bytes: Double
  public var measuredAt: String?
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
    "\(Self.commits(count)) not pushed to \(upstream ?? "the upstream")"
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
  public var disk: DeviceDisk?
  /// Set only on a device built from `physicalDevices`, never decoded from the `ios` record.
  public var physical = false
  public var model: String?
  public var leaseExpiresAt: String?

  enum CodingKeys: String, CodingKey { case name, udid, owned, state, activity, app, disk }

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
    disk = try c.decodeIfPresent(DeviceDisk.self, forKey: .disk)
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
  public var disk: DeviceDisk?
  public var model: String?
  public var leaseExpiresAt: String?
}

/// A physical phone or tablet the workspace leases with `ios --device`, `android --device` or `device lock`.
/// `connection` is `connected`, `disconnected` or `unknown`.
public struct PhysicalDevice: Decodable, Hashable, Sendable {
  public struct Lease: Decodable, Hashable, Sendable {
    public var holder: String
    public var kind: String
    public var grantedAt: String?
    public var expiresAt: String
  }

  public var platform: String
  public var slot: String
  public var id: String
  public var name: String?
  public var model: String?
  public var connection: String
  public var lease: Lease

  var ref: DeviceRef {
    let name = name ?? id
    if platform == "ios" {
      var device = IosDevice(name: name, udid: id, owned: false, state: connection)
      device.physical = true
      device.model = model
      device.leaseExpiresAt = lease.expiresAt
      return .ios(slot: slot, device)
    }
    return .android(
      slot: slot,
      AndroidDevice(
        name: name, owned: false, physical: true, serial: id, state: connection, model: model,
        leaseExpiresAt: lease.expiresAt))
  }
}

/// The workspace's Stim-owned Chrome from `stim web`. `pid`, `cdpEndpoint` and `targetId` are set only while it
/// runs; `page` is the document it loaded last, whether that load failed, and the in-app route it shows now when one
/// moved it off that document.
public struct WebBrowser: Decodable, Hashable, Sendable {
  public struct Page: Decodable, Hashable, Sendable {
    public var url: String
    public var state: String
    public var error: String?
    public var route: String?
  }

  public var running: Bool
  public var pid: Int?
  public var url: String
  public var headless: Bool
  public var viewport: String
  public var profile: String
  public var cdpEndpoint: String?
  public var targetId: String?
  public var page: Page?
  public var activity: DeviceActivity?

  /// The page it shows now, or the one `stim web` opened before the first load.
  public var currentURL: String { page?.route ?? page?.url ?? url }

  public var pageFailed: Bool { running && page?.state == "failed" }
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
  public struct Stop: Decodable, Hashable, Sendable {
    public var reason: String
    public var at: String?
  }

  public var port: Int
  public var running: Bool
  public var pid: Int?
  public var lastStop: Stop?
  /// Absent when the Metro log has no bundle request, and from a `stim` that does not report bundles.
  public var bundle: MetroBundle?
}

/// Metro's bundle requests: `percent` (0 to 100) only while Metro reports progress, `last` the newest finished one.
public struct MetroBundle: Decodable, Hashable, Sendable {
  public struct Finished: Decodable, Hashable, Sendable {
    public var platform: String?
    /// `ok` or `failed`.
    public var status: String
    public var durationMs: Double
    public var finishedAt: String
  }

  public var bundling: Bool
  public var platform: String?
  public var startedAt: String?
  public var percent: Double?
  public var last: Finished?
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
