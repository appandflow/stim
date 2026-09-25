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

/// One workspace's disk use by category. A nil category was not measured.
public struct WorkspaceStorage: Identifiable, Hashable, Sendable {
  public var path: String
  public var worktreePath: String
  public var repository: String?
  public var branch: String?
  public var buildOutputs: Int64?
  /// Why `stim gc --delete` keeps the build outputs, or nil when it clears them.
  public var buildOutputsKept: String?
  public var nodeModules: Int64?
  public var devices: Int64?
  public var deviceCount: Int
  public var worktree: GcReport.LinkedWorktree?

  public var id: String { path }

  public var total: Int64 { [buildOutputs, nodeModules, devices].compactMap { $0 }.reduce(0, +) }
}

/// A location shown with its size: Stim-managed and reclaimable through the CLI, or outside Stim and shown
/// for information.
public struct StorageLocation: Identifiable, Hashable, Sendable {
  public var title: String
  public var path: String?
  public var bytes: Int64?
  public var detail: String?

  public var id: String { title + (path ?? "") }

  public init(title: String, path: String?, bytes: Int64?, detail: String?) {
    self.title = title
    self.path = path
    self.bytes = bytes
    self.detail = detail
  }
}

public struct StorageReport: Sendable {
  public var workspaces: [WorkspaceStorage]
  /// Stim's shared caches, from `stim gc --json`.
  public var caches: [GcReport.Cache]
  /// Owned devices `stim gc --delete` deletes: parked, orphaned and stale.
  public var reclaimableDevices: StorageLocation?
  public var unmanaged: [StorageLocation]

  public static func make(
    environments: [Workspace], gc: GcReport?, sizes: [String: Int64], paths: StoragePaths
  ) -> StorageReport {
    let outputs = Dictionary(
      (gc?.sections.workspaceBuildOutputs ?? []).compactMap { entry in entry.projectRoot.map { ($0, entry) } },
      uniquingKeysWith: { first, _ in first })
    let worktrees = Dictionary(
      (gc?.sections.linkedWorktrees ?? []).map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
    var stimSimulators = Set((gc?.deletableDevices ?? []).compactMap(\.udid).map { $0.uppercased() })

    let workspaces = environments.map { env -> WorkspaceStorage in
      let root = env.worktree?.path ?? env.path
      var deviceBytes: Int64?
      var count = 0
      for device in env.devices {
        let path: String
        switch device {
        case .ios(_, let sim) where sim.owned:
          stimSimulators.insert(sim.udid.uppercased())
          path = paths.simulator(sim.udid.uppercased())
        case .android(_, let avd) where avd.owned && !avd.physical:
          path = paths.avd(avd.name)
        default:
          continue
        }
        count += 1
        if let bytes = sizes[path] { deviceBytes = (deviceBytes ?? 0) + bytes }
      }
      let output = outputs[env.path]
      return WorkspaceStorage(
        path: env.path, worktreePath: root, repository: env.worktree?.repository, branch: env.worktree?.branch,
        buildOutputs: output?.bytes,
        buildOutputsKept: output.flatMap { $0.willClear == true ? nil : ($0.detail ?? "kept") },
        nodeModules: sizes["\(root)/node_modules"], devices: deviceBytes, deviceCount: count,
        worktree: worktrees[root])
    }
    .sorted { ($0.total, $1.path) > ($1.total, $0.path) }

    let devices = gc?.deletableDevices ?? []
    let reclaimableDevices =
      devices.isEmpty
      ? nil
      : StorageLocation(
        title: devices.count == 1 ? "1 parked, orphaned or stale device" : "\(devices.count) parked, orphaned or stale devices",
        path: nil, bytes: devices.contains { $0.bytes != nil } ? devices.compactMap(\.bytes).reduce(0, +) : nil,
        detail: devices.compactMap(\.name).joined(separator: ", "))

    let caches = gc?.sections.caches ?? []
    var unmanaged: [StorageLocation] = []
    let simulatorEntries = sizes.filter { path, _ in
      (path as NSString).deletingLastPathComponent == paths.simulatorDevices
        && UUID(uuidString: (path as NSString).lastPathComponent) != nil
    }
    if !simulatorEntries.isEmpty {
      let other = simulatorEntries.filter { !stimSimulators.contains(($0.key as NSString).lastPathComponent.uppercased()) }
      unmanaged.append(
        StorageLocation(
          title: "Simulators Stim does not own", path: paths.simulatorDevices, bytes: other.values.reduce(0, +),
          detail: "\(other.count) of \(simulatorEntries.count) CoreSimulator devices"))
    }
    for location in paths.unmanaged {
      guard let measured = sizes[location.path] else { continue }
      let inside = caches.filter { $0.dir.hasPrefix(location.path + "/") }
      let stimBytes = inside.compactMap(\.bytes).reduce(0, +)
      unmanaged.append(
        StorageLocation(
          title: location.title, path: location.path, bytes: max(0, measured - stimBytes),
          detail: inside.isEmpty ? nil : "Excludes \(inside.map(\.name).joined(separator: ", ")), listed under Stim"))
    }
    return StorageReport(
      workspaces: workspaces, caches: caches, reclaimableDevices: reclaimableDevices, unmanaged: unmanaged)
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
