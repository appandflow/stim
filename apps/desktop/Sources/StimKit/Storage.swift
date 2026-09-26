import Foundation

/// Where the space Stim Desktop measures lives. Stim's own directories are sized by `stim gc --json`;
/// these are the paths the app sizes itself with `du`, none of them under `$STIM_HOME`.
public struct StoragePaths: Sendable {
  public var home: String
  public var simulatorDevices: String
  public var avds: String
  public var derivedData: String
  public var gradleCaches: String
  public var libraryCaches: String

  /// The AVD directory follows the Android tools: `ANDROID_AVD_HOME`, then `ANDROID_USER_HOME/avd`, then `~/.android/avd`.
  public init(home: String, environment: [String: String] = [:]) {
    self.home = home
    simulatorDevices = "\(home)/Library/Developer/CoreSimulator/Devices"
    avds =
      environment["ANDROID_AVD_HOME"] ?? environment["ANDROID_USER_HOME"].map { "\($0)/avd" } ?? "\(home)/.android/avd"
    derivedData = "\(home)/Library/Developer/Xcode/DerivedData"
    gradleCaches = "\(home)/.gradle/caches"
    libraryCaches = "\(home)/Library/Caches"
  }

  public func simulator(_ udid: String) -> String { "\(simulatorDevices)/\(udid)" }
  public func avd(_ name: String) -> String { "\(avds)/\(name).avd" }

  /// Directories `du -d 1` sizes entry by entry, so each device can be attributed.
  public var deviceSets: [String] { [simulatorDevices, avds] }

  public var unmanaged: [(title: String, path: String)] {
    [
      ("Xcode DerivedData", derivedData),
      ("Gradle caches", gradleCaches),
      ("~/Library/Caches", libraryCaches),
    ]
  }
}

public enum DiskSizes {
  /// Parses `du -k` output, one `<KiB>\t<path>` line per entry. `du` still prints what it could read when it
  /// reports an unreadable entry, so partial output is kept.
  public static func parse(_ output: String) -> [String: Int64] {
    var sizes: [String: Int64] = [:]
    for line in output.split(separator: "\n") {
      guard let tab = line.firstIndex(of: "\t"), let kib = Int64(line[..<tab]) else { continue }
      sizes[String(line[line.index(after: tab)...])] = kib * 1024
    }
    return sizes
  }
}

/// One size on the Storage page, or why it has none.
public enum DiskSize: Hashable, Sendable {
  case size(Int64)
  /// Nothing is there to size.
  case absent
  case measuring
  /// The tool that sizes it did not finish or could not read it.
  case failed
  case notMeasured

  /// The bytes it takes, zero when absent, nil when unknown.
  public var bytes: Int64? {
    switch self {
    case .size(let bytes): return bytes
    case .absent: return 0
    case .measuring, .failed, .notMeasured: return nil
    }
  }

  /// A size from several parts: unknown while any part is measuring or failed.
  static func sum(_ parts: [DiskSize]) -> DiskSize {
    if parts.isEmpty { return .absent }
    if parts.contains(.measuring) { return .measuring }
    if parts.contains(.failed) { return .failed }
    if parts.contains(.notMeasured) { return .notMeasured }
    return .size(parts.compactMap(\.bytes).reduce(0, +))
  }
}

/// What `du` has reported so far for the paths Stim Desktop asked it to size.
public struct DiskMeasurements: Sendable {
  /// Bytes by path, including each entry `du -d 1` reports inside a device set.
  public var sizes: [String: Int64]
  public var pending: Set<String>
  public var failed: Set<String>
  /// Paths that did not exist when sizing started.
  public var absent: Set<String>

  public init(
    sizes: [String: Int64] = [:], pending: Set<String> = [], failed: Set<String> = [], absent: Set<String> = []
  ) {
    self.sizes = sizes
    self.pending = pending
    self.failed = failed
    self.absent = absent
  }

  public func measure(_ path: String) -> DiskSize {
    if let bytes = sizes[path] { return .size(bytes) }
    if absent.contains(path) { return .absent }
    if pending.contains(path) { return .measuring }
    if failed.contains(path) { return .failed }
    return .notMeasured
  }

  /// An entry inside `set`, sized by a `du -d 1` of the set. A finished set without the entry means it is not on disk.
  func measure(_ path: String, in set: String) -> DiskSize {
    if let bytes = sizes[path] { return .size(bytes) }
    switch measure(set) {
    case .size, .absent: return .absent
    case let other: return other
    }
  }
}

/// One workspace, or one linked worktree without a workspace, and its disk use by category.
public struct WorkspaceStorage: Identifiable, Hashable, Sendable {
  public var path: String
  public var worktreePath: String
  public var repository: String?
  public var branch: String?
  public var buildOutputs: DiskSize
  /// Why `stim gc --delete` keeps the build outputs, or nil when it clears them.
  public var buildOutputsKept: String?
  public var nodeModules: DiskSize
  public var logs: DiskSize
  /// What `stim gc --delete` would trim from the logs, or nil when it trims nothing.
  public var logsTrimmed: Int64?
  /// Why `stim gc --delete` keeps logs it would otherwise trim.
  public var logsKept: String?
  public var devices: DiskSize
  public var deviceCount: Int
  public var worktree: GcReport.LinkedWorktree?
  /// A registered project whose folder is gone; `stim gc --delete` drops its record and devices.
  public var missing = false
  /// A linked worktree `stim worktree warm` has not set up, listed by `stim status` apart from workspaces.
  public var unprovisioned = false

  public var id: String { path }

  /// The sum of the categories that have a size: a lower bound while `totalComplete` is false, and nil
  /// while no category has anything measured on disk.
  public var total: Int64? {
    let parts = [buildOutputs, nodeModules, logs, devices]
    guard totalComplete || parts.contains(where: { if case .size(let bytes) = $0 { return bytes > 0 } else { return false } }) else {
      return nil
    }
    return parts.compactMap(\.bytes).reduce(0, +)
  }

  /// Whether every category has a size, so `total` is not a lower bound.
  public var totalComplete: Bool { [buildOutputs, nodeModules, logs, devices].allSatisfy { $0.bytes != nil } }

}

/// A location shown with its size: Stim-managed and reclaimable through the CLI, or outside Stim and shown
/// for information.
public struct StorageLocation: Identifiable, Hashable, Sendable {
  public var title: String
  public var path: String?
  public var size: DiskSize
  public var detail: String?

  public var id: String { title + (path ?? "") }

  public init(title: String, path: String?, size: DiskSize, detail: String?) {
    self.title = title
    self.path = path
    self.size = size
    self.detail = detail
  }
}

public struct StorageReport: Sendable {
  /// Largest first; rows with no size yet last.
  public var workspaces: [WorkspaceStorage]
  /// Stim's shared caches from `stim gc --json` that hold something, largest first.
  public var caches: [GcReport.Cache]
  /// Every cache `stim gc --json` reports, for `--cache` selection and titles.
  public var allCaches: [GcReport.Cache]
  /// Caches `stim gc --json` sized at zero bytes.
  public var emptyCaches: [GcReport.Cache]
  /// Owned devices `stim gc --delete` deletes: parked, orphaned and stale.
  public var reclaimableDevices: StorageLocation?
  /// Largest first.
  public var unmanaged: [StorageLocation]

  public static func make(
    environments: [Workspace], unprovisioned: [UnprovisionedWorktree] = [], gc: GcReport?,
    disk: DiskMeasurements, paths: StoragePaths
  ) -> StorageReport {
    let outputs = Dictionary(
      (gc?.sections.workspaceBuildOutputs ?? []).compactMap { entry in entry.projectRoot.map { ($0, entry) } },
      uniquingKeysWith: { first, _ in first })
    let logs = Dictionary(
      (gc?.sections.workspaceLogs ?? []).compactMap { entry in entry.projectRoot.map { ($0, entry) } },
      uniquingKeysWith: { first, _ in first })
    let worktrees = Dictionary(
      (gc?.sections.linkedWorktrees ?? []).map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
    let dead = Set((gc?.sections.deadProjects ?? []).map(\.path))
    var stimSimulators = Set((gc?.deletableDevices ?? []).compactMap(\.udid).map { $0.uppercased() })

    var workspaces = environments.map { env -> WorkspaceStorage in
      let root = env.worktree?.path ?? env.path
      var devices: [DiskSize] = []
      for device in env.devices {
        switch device {
        case .ios(_, let sim) where sim.owned:
          stimSimulators.insert(sim.udid.uppercased())
          devices.append(disk.measure(paths.simulator(sim.udid.uppercased()), in: paths.simulatorDevices))
        case .android(_, let avd) where avd.owned && !avd.physical:
          devices.append(disk.measure(paths.avd(avd.name), in: paths.avds))
        default:
          continue
        }
      }
      let output = outputs[env.path]
      let buildOutputs: DiskSize =
        gc == nil ? .notMeasured : output.map { $0.bytes.map(DiskSize.size) ?? .failed } ?? .absent
      let log = logs[env.path]
      let missing = dead.contains(env.path)
      return WorkspaceStorage(
        path: env.path, worktreePath: root, repository: env.worktree?.repository, branch: env.worktree?.branch,
        buildOutputs: buildOutputs,
        buildOutputsKept: output.flatMap { $0.willClear == true ? nil : ($0.detail ?? "kept") },
        nodeModules: missing ? .absent : disk.measure("\(root)/node_modules"),
        logs: gc?.sections.workspaceLogs == nil ? .notMeasured : log.map { .size($0.bytes) } ?? .absent,
        logsTrimmed: log.flatMap { $0.willTrim ? $0.trimBytes : nil },
        logsKept: log.flatMap { $0.trimBytes > 0 && !$0.willTrim ? ($0.detail ?? "kept") : nil },
        devices: .sum(devices),
        deviceCount: devices.count, worktree: worktrees[root], missing: missing)
    }
    let listed = Set(workspaces.map(\.worktreePath))
    for tree in unprovisioned where !listed.contains(tree.path) {
      workspaces.append(
        WorkspaceStorage(
          path: tree.path, worktreePath: tree.path, repository: tree.repository, branch: tree.branch,
          buildOutputs: .absent, nodeModules: disk.measure("\(tree.path)/node_modules"), logs: .absent,
          devices: .absent,
          deviceCount: 0, worktree: worktrees[tree.path], unprovisioned: true))
    }
    workspaces.sort { a, b in
      switch (a.total, b.total) {
      case let (x?, y?) where x != y: return x > y
      case (.some, nil): return true
      case (nil, .some): return false
      default: return a.path < b.path
      }
    }

    let devices = gc?.deletableDevices ?? []
    let reclaimableDevices =
      devices.isEmpty
      ? nil
      : StorageLocation(
        title: devices.count == 1 ? "1 parked, orphaned or stale device" : "\(devices.count) parked, orphaned or stale devices",
        path: nil, size: devices.contains { $0.bytes != nil } ? .size(devices.compactMap(\.bytes).reduce(0, +)) : .failed,
        detail: devices.compactMap(\.name).joined(separator: ", "))

    let allCaches = gc?.sections.caches ?? []
    var unmanaged: [StorageLocation] = []
    let simulatorEntries = disk.sizes.filter { path, _ in
      (path as NSString).deletingLastPathComponent == paths.simulatorDevices
        && UUID(uuidString: (path as NSString).lastPathComponent) != nil
    }
    let other = simulatorEntries.filter { !stimSimulators.contains(($0.key as NSString).lastPathComponent.uppercased()) }
    let simulatorSet = disk.measure(paths.simulatorDevices)
    unmanaged.append(
      StorageLocation(
        title: "Simulators Stim does not own", path: paths.simulatorDevices,
        size: simulatorSet.bytes == nil ? simulatorSet : .size(other.values.reduce(0, +)),
        detail: simulatorEntries.isEmpty
          ? "Created in Xcode or with simctl" : "\(other.count) of \(simulatorEntries.count) CoreSimulator devices"))
    for location in paths.unmanaged {
      let inside = allCaches.filter { $0.dir.hasPrefix(location.path + "/") }
      let stimBytes = inside.compactMap(\.bytes).reduce(0, +)
      let measured = disk.measure(location.path)
      unmanaged.append(
        StorageLocation(
          title: location.title, path: location.path,
          size: measured.bytes.map { .size(max(0, $0 - stimBytes)) } ?? measured,
          detail: inside.isEmpty ? nil : "Excludes \(inside.map { $0.title(among: allCaches) }.joined(separator: ", ")), listed under Stim"))
    }
    return StorageReport(
      workspaces: workspaces,
      caches: allCaches.filter { $0.bytes != 0 }.sorted { ($0.bytes ?? -1) > ($1.bytes ?? -1) },
      allCaches: allCaches, emptyCaches: allCaches.filter { $0.bytes == 0 },
      reclaimableDevices: reclaimableDevices,
      unmanaged: unmanaged.sorted { ($0.size.bytes ?? -1) > ($1.size.bytes ?? -1) })
  }
}

/// Where a linked worktree is in its life, for the Storage view's lifecycle column.
public enum WorktreeLifecycle: Hashable, Sendable {
  case merged(into: String)
  case pullRequest(number: Int, url: String)
  case stale(days: Int)
  case active

  /// Days without recorded use after which a worktree with no open pull request reads as stale.
  public static let staleDays = 7

  /// `worktree` is the `stim gc --json` entry, nil for a checkout gc does not sweep. `pulls` maps branch
  /// names to open pull requests, nil when the GitHub CLI could not answer.
  public init?(worktree: GcReport.LinkedWorktree?, branch: String?, pulls: [String: PullRequest]?) {
    if let into = worktree?.mergedInto {
      self = .merged(into: into)
    } else if let branch, let pull = pulls?[branch] {
      self = .pullRequest(number: pull.number, url: pull.url)
    } else if let worktree {
      if let days = worktree.idleDays, days >= Self.staleDays {
        self = .stale(days: days)
      } else {
        self = .active
      }
    } else {
      return nil
    }
  }

  public var title: String {
    switch self {
    case .merged(let into): return "Merged into \(into.replacingOccurrences(of: "origin/", with: ""))"
    case .pullRequest(let number, _): return "PR #\(number) open"
    case .stale(let days): return "Stale \(days)d"
    case .active: return "Active"
    }
  }
}

public struct PullRequest: Decodable, Hashable, Sendable {
  public var number: Int
  public var url: String
  public var headRefName: String

  /// `gh pr list` arguments for the open pull requests of the repository in the working directory.
  public static let listArguments = ["pr", "list", "--state", "open", "--json", "number,url,headRefName", "--limit", "200"]

  /// Open pull requests by head branch, or nil when the output is not a `gh pr list --json` array.
  public static func byBranch(_ json: Data) -> [String: PullRequest]? {
    guard let pulls = try? JSONDecoder().decode([PullRequest].self, from: json) else { return nil }
    return Dictionary(pulls.map { ($0.headRefName, $0) }, uniquingKeysWith: { first, _ in first })
  }
}
