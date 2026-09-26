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
  public var systemImages: String

  /// The AVD directory follows the Android tools: `ANDROID_AVD_HOME`, then `ANDROID_USER_HOME/avd`, then `~/.android/avd`.
  public init(home: String, environment: [String: String] = [:]) {
    self.home = home
    simulatorDevices = "\(home)/Library/Developer/CoreSimulator/Devices"
    avds =
      environment["ANDROID_AVD_HOME"] ?? environment["ANDROID_USER_HOME"].map { "\($0)/avd" } ?? "\(home)/.android/avd"
    derivedData = "\(home)/Library/Developer/Xcode/DerivedData"
    gradleCaches = "\(home)/.gradle/caches"
    libraryCaches = "\(home)/Library/Caches"
    let sdk = [environment["ANDROID_HOME"], environment["ANDROID_SDK_ROOT"]].compactMap { $0 }.first { !$0.isEmpty }
      ?? "\(home)/Library/Android/sdk"
    systemImages = "\(sdk.hasSuffix("/") ? String(sdk.dropLast()) : sdk)/system-images"
  }

  public func simulator(_ udid: String) -> String { "\(simulatorDevices)/\(udid)" }
  public func avd(_ name: String) -> String { "\(avds)/\(name).avd" }

  /// Directories `du` sizes entry by entry, with the depth that reaches each AVD and each system image.
  public var deviceSets: [(path: String, depth: Int)] { [(avds, 1), (systemImages, 3)] }

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

  /// What `stim worktree remove` frees: `node_modules`, build outputs and logs. Its devices are parked or deleted
  /// by the pool rules, so they are left out.
  public var removable: Int64? {
    let parts = [nodeModules, buildOutputs, logs].compactMap(\.bytes)
    return parts.isEmpty ? nil : parts.reduce(0, +)
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

/// A simulator or AVD from the `stim gc --json` inventory, with its size.
public struct DeviceStorage: Identifiable, Hashable, Sendable {
  public var device: GcReport.InventoryDevice
  public var size: DiskSize

  public var id: String { "\(device.kind):\(device.id)" }
  public var isStim: Bool { [.workspace, .parked, .orphaned].contains(device.owner) }
  public var lastUsed: Date? { device.lastUsedAt.flatMap(StorageReport.parseDate) }

  /// The runtime as people name it: "iOS 27.0", or "Android 36 · google_apis_playstore".
  public var runtimeTitle: String? {
    guard let runtime = device.runtime else { return nil }
    return device.kind == "ios" ? StorageReport.iosRuntimeTitle(runtime) : StorageReport.systemImageTitle(runtime)
  }
}

/// An iOS simulator runtime or an Android system image, and how many devices use it.
public struct RuntimeStorage: Identifiable, Hashable, Sendable {
  public var id: String
  public var title: String
  public var detail: String?
  public var size: DiskSize
  public var deviceCount: Int
  /// The vendor command that deletes it, for the user to run. Stim never runs it.
  public var command: String?

  public var unused: Bool { deviceCount == 0 }
}

/// The workspaces and worktrees of one repository.
public struct RepositoryStorage: Identifiable, Hashable, Sendable {
  public var path: String
  public var worktrees: [WorkspaceStorage]

  public var id: String { path }
  public var name: String { (path as NSString).lastPathComponent }
  /// The sum of its worktrees, counting a `node_modules` that two workspaces of one worktree share once.
  public var total: Int64? {
    var seen = Set<String>()
    let known = worktrees.compactMap { workspace -> Int64? in
      guard let total = workspace.total else { return nil }
      return seen.insert(workspace.worktreePath).inserted ? total : total - (workspace.nodeModules.bytes ?? 0)
    }
    return known.isEmpty ? nil : known.reduce(0, +)
  }
  public var totalComplete: Bool { worktrees.allSatisfy(\.totalComplete) }
}

/// The CLI command that frees a "Safe to free now" item.
public enum FreeAction: Hashable, Sendable {
  /// `stim gc --delete`: devices, records, logs, idle build outputs and merged worktrees together.
  case gc
  /// `stim gc --delete --cache workspaces`: build outputs of idle workspaces.
  case workspaceOutputs
  /// `stim gc --delete --cache <selector>`: one shared cache, emptied whole.
  case cache(String)
  /// `stim worktree remove <path>`, run from the repository.
  case removeWorktree(path: String, repository: String?)

  /// Whether `stim gc --delete` also frees what this action frees.
  public var partOfGc: Bool {
    switch self {
    case .gc, .workspaceOutputs, .removeWorktree: return true
    case .cache: return false
    }
  }
}

/// One thing Stim can free now, and the command that frees it.
public struct FreeItem: Identifiable, Hashable, Sendable {
  public var id: String
  public var title: String
  /// A workspace or worktree the view names, or nil when `title` says it all.
  public var path: String?
  public var detail: String
  public var bytes: Int64?
  public var action: FreeAction
}

/// Which items a set of selected actions frees, and the commands that free them.
public enum FreePlan {
  /// The actions checked by default: everything but emptying whole caches.
  public static func defaultSelection(_ items: [FreeItem]) -> Set<FreeAction> {
    Set(items.map(\.action).filter { if case .cache = $0 { return false } else { return true } })
  }

  /// The selected actions that still free a listed item, so a row a refreshed report no longer lists is never acted on.
  public static func effective(_ selected: Set<FreeAction>, items: [FreeItem]) -> Set<FreeAction> {
    selected.intersection(items.map(\.action))
  }

  public static func frees(_ action: FreeAction, selected: Set<FreeAction>) -> Bool {
    selected.contains(action) || (action.partOfGc && selected.contains(.gc))
  }

  /// Whether the item's own checkbox decides, rather than `stim gc --delete` including it anyway.
  public static func canToggle(_ action: FreeAction, selected: Set<FreeAction>) -> Bool {
    action == .gc || !action.partOfGc || !selected.contains(.gc)
  }

  public static func bytes(_ items: [FreeItem], selected: Set<FreeAction>) -> Int64 {
    items.filter { frees($0.action, selected: selected) }.compactMap(\.bytes).reduce(0, +)
  }

  /// The commands to run, worktree removals first, each once.
  public static func commands(_ selected: Set<FreeAction>, home: String) -> [StimCommand] {
    var commands: [StimCommand] = []
    if !selected.contains(.gc) {
      for case let .removeWorktree(path, repository) in selected.sorted(by: { "\($0)" < "\($1)" }) {
        commands.append(StimCommand(["worktree", "remove", path], cwd: repository ?? home))
      }
      if selected.contains(.workspaceOutputs) {
        commands.append(StimCommand(["gc", "--json", "--delete", "--cache", "workspaces"], cwd: home))
      }
    } else {
      commands.append(StimCommand(["gc", "--json", "--delete"], cwd: home))
    }
    for case let .cache(selector) in selected.sorted(by: { "\($0)" < "\($1)" }) {
      commands.append(StimCommand(["gc", "--json", "--delete", "--cache", selector], cwd: home))
    }
    return commands
  }

  /// The `stim gc --json` dry run that previews `commands` when they are one gc run, whose sheet then offers
  /// the same scope with `--delete`; nil when they need a confirmation of their own.
  public static func preview(_ commands: [StimCommand]) -> [String]? {
    guard commands.count == 1, let only = commands.first, only.arguments.first == "gc" else { return nil }
    return only.arguments.filter { $0 != "--delete" }
  }
}

/// What the stacked disk bar splits the space into.
public enum DiskCategory: String, CaseIterable, Hashable, Sendable {
  case stimDevices
  case stimCaches
  case nodeModules
  case otherDevices
  case runtimes
  case otherTools

  public var title: String {
    switch self {
    case .stimDevices: return "Stim devices"
    case .stimCaches: return "Stim caches and outputs"
    case .nodeModules: return "node_modules"
    case .otherDevices: return "Other simulators and AVDs"
    case .runtimes: return "Runtimes and system images"
    case .otherTools: return "Other tools"
    }
  }
}

/// A category's measured bytes, and whether anything in it is still unsized.
public struct CategoryTotal: Hashable, Sendable {
  public var bytes: Int64
  public var complete: Bool
}

public struct StorageReport: Sendable {
  /// Largest first; rows with no size yet last.
  public var workspaces: [WorkspaceStorage]
  /// Workspaces grouped by repository, largest first.
  public var repositories: [RepositoryStorage]
  /// Every cache `stim gc --json` reports, for `--cache` selection and titles.
  public var allCaches: [GcReport.Cache]
  /// What Stim can free now, largest first.
  public var free: [FreeItem]
  /// Every simulator and AVD, largest first; empty when the CLI does not report an inventory.
  public var devices: [DeviceStorage]
  /// iOS runtimes and Android system images, unused ones first, then largest first.
  public var runtimes: [RuntimeStorage]
  /// Whether `stim gc --json` reported an inventory; false with a CLI that predates it.
  public var hasInventory: Bool
  /// Why part of the inventory is missing, as the CLI reported it.
  public var inventoryNotices: [String]
  /// Largest first.
  public var unmanaged: [StorageLocation]
  public var categories: [DiskCategory: CategoryTotal]

  public func total(_ category: DiskCategory) -> CategoryTotal {
    categories[category] ?? CategoryTotal(bytes: 0, complete: false)
  }

  static func parseDate(_ text: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    if let date = formatter.date(from: text) { return date }
    formatter.formatOptions.insert(.withFractionalSeconds)
    return formatter.date(from: text)
  }

  /// "com.apple.CoreSimulator.SimRuntime.iOS-27-0" reads "iOS 27.0".
  static func iosRuntimeTitle(_ identifier: String) -> String {
    guard let last = identifier.split(separator: ".").last else { return identifier }
    let parts = last.split(separator: "-")
    guard let platform = parts.first, parts.count > 1 else { return String(last) }
    return "\(platform) \(parts.dropFirst().joined(separator: "."))"
  }

  /// "system-images;android-36;google_apis;arm64-v8a" reads "Android 36 · google_apis".
  static func systemImageTitle(_ package: String) -> String {
    let parts = package.split(separator: ";").map(String.init)
    guard parts.count >= 3, parts[1].hasPrefix("android-") else { return package }
    return "Android \(parts[1].dropFirst("android-".count)) \u{00B7} \(parts[2])"
  }

  public static func make(
    environments: [Workspace], unprovisioned: [UnprovisionedWorktree] = [], gc: GcReport?,
    disk: DiskMeasurements, paths: StoragePaths, projectRoots: [String: String] = [:]
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
    let inventory = gc?.inventory

    let devices = (inventory?.devices ?? []).map { device -> DeviceStorage in
      let size: DiskSize
      if device.kind == "ios" {
        size = device.bytes.map(DiskSize.size) ?? .failed
      } else if let directory = device.directory {
        size =
          (directory as NSString).deletingLastPathComponent == paths.avds
          ? disk.measure(directory, in: paths.avds) : .notMeasured
      } else {
        size = .absent
      }
      return DeviceStorage(device: device, size: size)
    }
    .sorted { ($0.size.bytes ?? -1, $1.device.name) > ($1.size.bytes ?? -1, $0.device.name) }

    var workspaces = environments.map { env -> WorkspaceStorage in
      let root = env.worktree?.path ?? env.path
      var sizes: [DiskSize] = []
      if inventory != nil {
        sizes = devices.filter { $0.device.owner == .workspace && $0.device.project == env.path }.map(\.size)
      } else {
        for device in env.devices {
          switch device {
          case .ios(_, let sim) where sim.owned:
            sizes.append(disk.measure(paths.simulator(sim.udid.uppercased()), in: paths.simulatorDevices))
          case .android(_, let avd) where avd.owned && !avd.physical:
            sizes.append(disk.measure(paths.avd(avd.name), in: paths.avds))
          default:
            continue
          }
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
        devices: .sum(sizes),
        deviceCount: sizes.count, worktree: worktrees[root], missing: missing)
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
    workspaces.sort(by: largestFirst(\.total, \.path))
    let repositories = Dictionary(grouping: workspaces) { projectRoots[$0.path] ?? $0.repository ?? $0.worktreePath }
      .map { RepositoryStorage(path: $0.key, worktrees: $0.value) }
      .sorted(by: largestFirst(\.total, \.path))

    let allCaches = gc?.sections.caches ?? []
    let free = gc.map { freeItems($0, workspaces: workspaces, caches: allCaches) } ?? []

    var runtimes = (inventory?.runtimes ?? []).map { runtime in
      RuntimeStorage(
        id: runtime.identifier,
        title: runtime.version.map { "iOS \($0)" } ?? runtime.runtimeIdentifier.map(iosRuntimeTitle) ?? runtime.identifier,
        detail: runtime.build, size: runtime.bytes.map(DiskSize.size) ?? .notMeasured,
        deviceCount: runtime.deviceCount, command: runtime.command)
    }
    runtimes += (inventory?.systemImages ?? []).map { image in
      RuntimeStorage(
        id: image.package, title: systemImageTitle(image.package),
        detail: image.package.split(separator: ";").last.map(String.init),
        size: disk.measure(image.directory, in: paths.systemImages), deviceCount: image.avdCount,
        command: image.command)
    }
    runtimes.sort { a, b in
      if a.unused != b.unused { return a.unused }
      return (a.size.bytes ?? -1, b.title) > (b.size.bytes ?? -1, a.title)
    }

    var unmanaged: [StorageLocation] = []
    for location in paths.unmanaged {
      let inside = allCaches.filter { $0.dir.hasPrefix(location.path + "/") }
      let stimBytes = inside.compactMap(\.bytes).reduce(0, +)
      let measured = disk.measure(location.path)
      unmanaged.append(
        StorageLocation(
          title: location.title, path: location.path,
          size: measured.bytes.map { .size(max(0, $0 - stimBytes)) } ?? measured,
          detail: inside.isEmpty ? nil : "Excludes \(inside.map { $0.title(among: allCaches) }.joined(separator: ", ")), counted under Stim"))
    }
    unmanaged.sort { ($0.size.bytes ?? -1) > ($1.size.bytes ?? -1) }

    func total(_ sizes: [DiskSize]) -> CategoryTotal {
      CategoryTotal(bytes: sizes.compactMap(\.bytes).reduce(0, +), complete: sizes.allSatisfy { $0.bytes != nil })
    }
    let stimOutputs =
      allCaches.map { $0.bytes.map(DiskSize.size) ?? .failed } + workspaces.flatMap { [$0.buildOutputs, $0.logs] }
      + (gc?.sections.orphanedWorkspaces ?? []).map { $0.bytes.map(DiskSize.size) ?? .failed }
    let inventoried: ([DiskSize]) -> [DiskSize] = { inventory == nil ? [.notMeasured] : $0 }
    var seenModules = Set<String>()
    let modules = workspaces.filter { seenModules.insert($0.worktreePath).inserted }.map(\.nodeModules)
    let categories: [DiskCategory: CategoryTotal] = [
      .stimDevices: total(inventoried(devices.filter(\.isStim).map(\.size))),
      .stimCaches: total(gc == nil ? [.notMeasured] : stimOutputs),
      .nodeModules: total(modules),
      .otherDevices: total(inventoried(devices.filter { !$0.isStim }.map(\.size))),
      .runtimes: total(inventoried(runtimes.map(\.size))),
      .otherTools: total(unmanaged.map(\.size)),
    ]

    return StorageReport(
      workspaces: workspaces, repositories: repositories, allCaches: allCaches, free: free, devices: devices,
      runtimes: runtimes, hasInventory: inventory != nil, inventoryNotices: inventory?.notices ?? [], unmanaged: unmanaged, categories: categories)
  }

  private static func largestFirst<T>(_ size: KeyPath<T, Int64?>, _ name: KeyPath<T, String>) -> (T, T) -> Bool {
    { a, b in
      switch (a[keyPath: size], b[keyPath: size]) {
      case let (x?, y?) where x != y: return x > y
      case (.some, nil): return true
      case (nil, .some): return false
      default: return a[keyPath: name] < b[keyPath: name]
      }
    }
  }

  static func freeItems(_ gc: GcReport, workspaces: [WorkspaceStorage], caches: [GcReport.Cache]) -> [FreeItem] {
    let s = gc.sections
    var items: [FreeItem] = []
    func devices(_ list: [GcReport.Device]?, _ detail: String) {
      for device in list ?? [] {
        let id = device.udid ?? device.id ?? device.name ?? "?"
        items.append(
          FreeItem(
            id: "device:\(id)", title: device.name ?? id, path: nil, detail: detail, bytes: device.bytes, action: .gc))
      }
    }
    devices(s.parkedSimulators, "Parked simulator, kept for reuse")
    devices(s.parkedEmulators, "Parked emulator, kept for reuse")
    devices(s.orphanedDevices, "Created by this Stim home; no workspace uses it")
    devices(s.staleDevices, "Its workspace has not been used for a while")
    for dir in s.orphanedWorkspaces ?? [] {
      items.append(
        FreeItem(
          id: "workspace:\(dir.dir ?? "?")", title: "Data of a removed workspace", path: nil,
          detail: dir.dir ?? "Stim workspace directory", bytes: dir.bytes, action: .gc))
    }
    for project in s.deadProjects ?? [] {
      items.append(
        FreeItem(
          id: "project:\(project.path)", title: "Record of a deleted folder", path: nil,
          detail: "\(project.path) is gone; stim gc drops its record and the devices it owned", bytes: nil, action: .gc))
    }
    for log in gc.trimmableLogs {
      items.append(
        FreeItem(
          id: "logs:\(log.projectRoot ?? "?")", title: "Logs over the cap", path: log.projectRoot,
          detail: "Each log keeps its newest 8 MiB", bytes: log.trimBytes, action: .gc))
    }
    for output in gc.clearableOutputs {
      items.append(
        FreeItem(
          id: "outputs:\(output.projectRoot ?? output.dir ?? "?")", title: "Build outputs", path: output.projectRoot,
          detail: output.idleDays.flatMap { $0 > 0 ? "Not used for \($0) days; rebuilt on the next run" : nil }
            ?? "Not in use; rebuilt on the next run",
          bytes: output.bytes, action: .workspaceOutputs))
    }
    for worktree in gc.mergedWorktrees {
      let inside = workspaces.filter { $0.worktreePath == worktree.path }
      let bytes = inside.first?.nodeModules.bytes
      items.append(
        FreeItem(
          id: "worktree:\(worktree.path)", title: "Worktree", path: worktree.path,
          detail: (worktree.detail ?? worktree.mergedInto.map { "Merged into \($0)" } ?? "Merged")
            + "; its node_modules and checkout go, its devices are parked or deleted",
          bytes: bytes,
          action: .removeWorktree(path: worktree.path, repository: inside.first?.repository)))
    }
    for cache in caches where (cache.bytes ?? 0) > 0 {
      guard let selector = cache.selector(among: caches) else { continue }
      items.append(
        FreeItem(
          id: "cache:\(cache.dir)", title: cache.title(among: caches), path: nil,
          detail: "Shared cache, emptied whole; builds refill it", bytes: cache.bytes, action: .cache(selector)))
    }
    return items.sorted(by: largestFirst(\.bytes, \.id))
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
