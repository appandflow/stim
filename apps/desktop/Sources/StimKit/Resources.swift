import Foundation

/// One row of `ps -axo pid=,ppid=,rss=,time=,args=`.
public struct ProcessEntry: Equatable, Sendable {
  public var pid: Int
  public var ppid: Int
  public var residentBytes: Int64
  public var cpuSeconds: Double
  public var args: String

  public init(pid: Int, ppid: Int, residentBytes: Int64, cpuSeconds: Double, args: String) {
    self.pid = pid
    self.ppid = ppid
    self.residentBytes = residentBytes
    self.cpuSeconds = cpuSeconds
    self.args = args
  }
}

public enum ProcessTable {
  public static let psArguments = ["-axo", "pid=,ppid=,rss=,time=,args="]

  public static func snapshot() throws -> [ProcessEntry] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = psArguments
    let out = Pipe()
    process.standardOutput = out
    process.standardError = FileHandle.nullDevice
    try process.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return parse(String(decoding: data, as: UTF8.self))
  }

  public static func parse(_ output: String) -> [ProcessEntry] {
    output.split(separator: "\n").compactMap { line in
      let fields = line.split(separator: " ", maxSplits: 4, omittingEmptySubsequences: true)
      guard fields.count >= 4,
        let pid = Int(fields[0]), let ppid = Int(fields[1]), let rssKb = Int64(fields[2]),
        let cpu = cpuSeconds(fields[3])
      else { return nil }
      return ProcessEntry(
        pid: pid, ppid: ppid, residentBytes: rssKb * 1024, cpuSeconds: cpu,
        args: fields.count > 4 ? String(fields[4]) : "")
    }
  }

  /// macOS `ps` prints `time` as `[dd-][hh:]mm:ss.ss`, with minutes past 59 when there is no hour field.
  static func cpuSeconds(_ field: Substring) -> Double? {
    var rest = field
    var days = 0.0
    if let dash = rest.firstIndex(of: "-") {
      guard let d = Double(rest[..<dash]) else { return nil }
      days = d
      rest = rest[rest.index(after: dash)...]
    }
    var total = 0.0
    for part in rest.split(separator: ":") {
      guard let value = Double(part) else { return nil }
      total = total * 60 + value
    }
    return days * 86_400 + total
  }
}

/// The pids whose process trees make up a workspace: its supervisor and Metro, each owned
/// simulator's `launchd_sim`, and each emulator's qemu process.
public func workspaceRoots(_ env: Workspace, in processes: [ProcessEntry]) -> Set<Int> {
  var roots = Set<Int>()
  if env.live, let pid = env.supervisor?.pid { roots.insert(pid) }
  if let metro = env.metro, metro.running, let pid = metro.pid { roots.insert(pid) }
  for device in env.devices {
    switch device {
    case .ios(_, let sim):
      let marker = "/DEVICES/\(sim.udid.uppercased())/"
      for p in processes where p.args.hasPrefix("launchd_sim ") && p.args.uppercased().contains(marker) {
        roots.insert(p.pid)
      }
    case .android(_, let avd) where !avd.physical:
      let port = avd.serial.flatMap { $0.hasPrefix("emulator-") ? String($0.dropFirst("emulator-".count)) : nil }
      for p in processes where isEmulator(p.args, avd: avd.name, port: port) {
        roots.insert(p.pid)
      }
    case .android, .remote:
      break
    }
  }
  let existing = Set(processes.map(\.pid))
  return roots.intersection(existing)
}

private func isEmulator(_ args: String, avd: String, port: String?) -> Bool {
  let tokens = args.split(separator: " ")
  guard let exe = tokens.first, exe.split(separator: "/").last?.hasPrefix("qemu-system") == true else { return false }
  for (flag, value) in zip(tokens, tokens.dropFirst()) {
    if flag == "-avd" && value == avd { return true }
    if flag == "-port", let port, value == port { return true }
  }
  return false
}

/// Every pid in the trees under `roots`, each counted once.
public func processTree(roots: Set<Int>, in processes: [ProcessEntry]) -> Set<Int> {
  let children = Dictionary(grouping: processes, by: \.ppid)
  var seen = Set<Int>()
  var stack = Array(roots)
  while let pid = stack.popLast() {
    guard seen.insert(pid).inserted else { continue }
    stack.append(contentsOf: (children[pid] ?? []).map(\.pid).filter { $0 != pid })
  }
  return seen
}

public struct ResourceUsage: Equatable, Sendable {
  /// Percent of one core, as Activity Monitor reports it; nil on the first sample.
  public var cpuPercent: Double?
  public var residentBytes: Int64
  public var processCount: Int
}

/// Turns successive process tables into per-workspace usage. CPU is the change in
/// cumulative CPU time between two tables, so it needs a previous table.
public struct ResourceSampler: Sendable {
  private var previous: (cpu: [Int: Double], at: Date)?

  public init() {}

  public mutating func sample(
    _ workspaces: [Workspace], processes: [ProcessEntry], at now: Date
  ) -> [String: ResourceUsage] {
    let byPid = Dictionary(processes.map { ($0.pid, $0) }, uniquingKeysWith: { first, _ in first })
    let prior = previous
    let elapsed = prior.map { now.timeIntervalSince($0.at) } ?? 0
    var out: [String: ResourceUsage] = [:]
    for env in workspaces {
      let pids = processTree(roots: workspaceRoots(env, in: processes), in: processes)
      guard !pids.isEmpty else { continue }
      var resident: Int64 = 0
      var cpuDelta = 0.0
      for pid in pids {
        guard let p = byPid[pid] else { continue }
        resident += p.residentBytes
        cpuDelta += max(0, p.cpuSeconds - (prior?.cpu[pid] ?? 0))
      }
      let cpu: Double? = prior != nil && elapsed > 0 ? cpuDelta / elapsed * 100 : nil
      out[env.path] = ResourceUsage(cpuPercent: cpu, residentBytes: resident, processCount: pids.count)
    }
    previous = (Dictionary(processes.map { ($0.pid, $0.cpuSeconds) }, uniquingKeysWith: { first, _ in first }), now)
    return out
  }
}

/// A mounted volume and the Stim locations on it.
public struct DiskVolume: Equatable, Identifiable, Sendable {
  public var id: String
  public var name: String
  public var availableBytes: Int64
  public var totalBytes: Int64
  public var holds: [String]
  /// Free space without purgeable space, which is what Stim's disk budget measures.
  public var unpurgeableFreeBytes: Int64?

  /// The free space Stim Desktop shows: without purgeable space when the volume reports it.
  public var freeBytes: Int64 { unpurgeableFreeBytes ?? availableBytes }

  public init(
    id: String, name: String, availableBytes: Int64, totalBytes: Int64, holds: [String], unpurgeableFreeBytes: Int64? = nil
  ) {
    self.id = id
    self.name = name
    self.availableBytes = availableBytes
    self.totalBytes = totalBytes
    self.holds = holds
    self.unpurgeableFreeBytes = unpurgeableFreeBytes
  }
}

public enum DiskUsage {
  /// Probes the volume of each labelled path and merges paths that share a volume.
  public static func volumes(for locations: [(label: String, path: String)]) -> [DiskVolume] {
    merge(locations.compactMap { probe(label: $0.label, path: $0.path) })
  }

  static func merge(_ probes: [DiskVolume]) -> [DiskVolume] {
    var out: [DiskVolume] = []
    for probe in probes {
      if let i = out.firstIndex(where: { $0.id == probe.id }) {
        for label in probe.holds where !out[i].holds.contains(label) { out[i].holds.append(label) }
      } else {
        out.append(probe)
      }
    }
    return out
  }

  private static func probe(label: String, path: String) -> DiskVolume? {
    var url = URL(fileURLWithPath: path)
    while !FileManager.default.fileExists(atPath: url.path), url.path != "/" {
      url.deleteLastPathComponent()
    }
    let keys: Set<URLResourceKey> = [
      .volumeURLKey, .volumeNameKey, .volumeAvailableCapacityForImportantUsageKey, .volumeTotalCapacityKey,
      .volumeAvailableCapacityKey,
    ]
    guard let values = try? url.resourceValues(forKeys: keys),
      let volume = values.volume,
      let available = values.volumeAvailableCapacityForImportantUsage,
      let total = values.volumeTotalCapacity
    else { return nil }
    return DiskVolume(
      id: volume.path, name: values.volumeName ?? volume.lastPathComponent,
      availableBytes: available, totalBytes: Int64(total), holds: [label],
      unpurgeableFreeBytes: values.volumeAvailableCapacity.map(Int64.init))
  }
}

/// The Mac's memory in use, counted as Activity Monitor's "Memory Used": app memory, wired and compressed.
public struct MachineMemory: Equatable, Sendable {
  public enum Pressure: Sendable { case normal, warning, critical }

  public var usedBytes: Int64
  public var totalBytes: Int64
  public var pressure: Pressure?

  public static func read() -> MachineMemory? {
    var stats = vm_statistics64()
    var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &stats) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
      }
    }
    guard result == KERN_SUCCESS else { return nil }
    let app = Int64(stats.internal_page_count) - Int64(stats.purgeable_count)
    let pages = max(0, app) + Int64(stats.wire_count) + Int64(stats.compressor_page_count)
    return MachineMemory(
      usedBytes: pages * Int64(getpagesize()),
      totalBytes: Int64(ProcessInfo.processInfo.physicalMemory),
      pressure: readPressure())
  }

  // XNU exposes dispatch flags here, not its internal pressure enum:
  // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c
  private static func readPressure() -> Pressure? {
    var level: Int32 = 0
    var size = MemoryLayout<Int32>.size
    guard sysctlbyname("kern.memorystatus_vm_pressure_level", &level, &size, nil, 0) == 0 else { return nil }
    switch level {
    case 1: return .normal
    case 2: return .warning
    case 4: return .critical
    default: return nil
    }
  }
}

/// The parts of the `stim gc --json` dry run that size what Stim can reclaim.
public struct GcReport: Decodable, Sendable {
  public struct Sized: Decodable, Hashable, Sendable {
    public var dir: String?
    public var bytes: Int64?
  }

  public struct Device: Decodable, Hashable, Sendable {
    public var udid: String?
    public var id: String?
    public var name: String?
    public var bytes: Int64?
  }

  public struct LinkedWorktree: Decodable, Hashable, Sendable {
    public var path: String
    public var idleDays: Int?
    public var mergedInto: String?
    public var pullRequest: PullRequestState?
    public var willRemove: Bool
    public var reason: String?
    public var detail: String?
    public var eligibleAt: String?

    public init(
      path: String, idleDays: Int? = nil, mergedInto: String? = nil, pullRequest: PullRequestState? = nil,
      willRemove: Bool, reason: String? = nil, detail: String? = nil, eligibleAt: String? = nil
    ) {
      self.path = path
      self.idleDays = idleDays
      self.mergedInto = mergedInto
      self.pullRequest = pullRequest
      self.willRemove = willRemove
      self.reason = reason
      self.detail = detail
      self.eligibleAt = eligibleAt
    }
  }

  /// The pull request of a worktree's branch whose head is or contains HEAD, as `gh` reported it to `stim gc`.
  public struct PullRequestState: Decodable, Hashable, Sendable {
    public var number: Int
    /// `open`, `merged` or `closed`.
    public var state: String
    public var url: String
    public var containsHead: Bool

    public init(number: Int, state: String, url: String, containsHead: Bool) {
      self.number = number
      self.state = state
      self.url = url
      self.containsHead = containsHead
    }

    /// Merged or closed, with every commit of HEAD in it.
    public var isFinished: Bool { containsHead && (state == "merged" || state == "closed") }
  }

  public struct BuildOutputs: Decodable, Hashable, Sendable {
    public var dir: String?
    public var projectRoot: String?
    public var bytes: Int64?
    public var idleDays: Int?
    public var willClear: Bool?
    public var detail: String?
  }

  /// A workspace's `logs/`. `trimBytes` is what `stim gc --delete` would cut from logs over twice the rotation
  /// cap; `detail` says why it keeps them when `willTrim` is false.
  public struct WorkspaceLogs: Decodable, Hashable, Sendable {
    public var projectRoot: String?
    public var bytes: Int64
    public var trimBytes: Int64
    public var willTrim: Bool
    public var detail: String?
  }

  public struct Cache: Decodable, Hashable, Sendable {
    public var name: String
    public var dir: String
    public var bytes: Int64?
    public var note: String?
    public var willEmpty: Bool?

    /// The `stim gc --cache` argument that selects this cache alone: its name, else its directory, or nil
    /// when neither does. The CLI matches the argument as a case-insensitive substring of every cache's name
    /// and directory, and reserves `all` and `workspaces`.
    public func selector(among caches: [Cache]) -> String? {
      [name, dir].first { candidate in
        let wanted = candidate.trimmingCharacters(in: .whitespaces).lowercased()
        guard !wanted.isEmpty, wanted != "all", wanted != "workspaces" else { return false }
        return caches.filter { $0.name.lowercased().contains(wanted) || $0.dir.lowercased().contains(wanted) }.count == 1
      }
    }

    /// The cache's name, followed by its directory's last component when another cache has the same name.
    public func title(among caches: [Cache]) -> String {
      guard caches.contains(where: { $0.dir != dir && $0.name == name }) else { return name }
      return "\(name): \((dir as NSString).lastPathComponent)"
    }
  }

  public struct Path: Decodable, Hashable, Sendable {
    public var path: String
  }

  public struct Sections: Decodable, Sendable {
    public var deadProjects: [Path]?
    public var orphanedWorkspaces: [Sized]?
    public var linkedWorktrees: [LinkedWorktree]?
    public var parkedSimulators: [Device]?
    public var parkedEmulators: [Device]?
    public var orphanedDevices: [Device]?
    public var staleDevices: [Device]?
    public var workspaceLogs: [WorkspaceLogs]?
    public var workspaceBuildOutputs: [BuildOutputs]?
    public var caches: [Cache]?
  }

  public var sections: Sections
  /// Every simulator, AVD, iOS runtime and system image on the machine; nil from a CLI that predates it.
  public var inventory: Inventory?

  public struct Inventory: Decodable, Sendable {
    public var devices: [InventoryDevice]
    public var runtimes: [InventoryRuntime]
    public var systemImages: [InventorySystemImage]
    public var notices: [String]
  }

  public struct InventoryDevice: Decodable, Hashable, Sendable {
    public enum Owner: String, Decodable, Sendable {
      case workspace, parked, orphaned, otherStimHome, user

      public init(from decoder: Decoder) throws {
        self = Owner(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .user
      }
    }

    public var kind: String
    public var id: String
    public var name: String
    public var model: String?
    public var runtime: String?
    public var state: String?
    public var lastUsedAt: String?
    public var bytes: Int64?
    public var directory: String?
    public var owner: Owner
    public var project: String?
    public var slot: String?
  }

  public struct InventoryRuntime: Decodable, Hashable, Sendable {
    public var identifier: String
    public var runtimeIdentifier: String?
    public var version: String?
    public var build: String?
    public var bytes: Int64?
    public var deviceCount: Int
    public var command: String?
  }

  public struct InventorySystemImage: Decodable, Hashable, Sendable {
    public var package: String
    public var directory: String
    public var avdCount: Int
    public var command: String
  }

  public struct Reclaimable: Equatable, Sendable {
    public var bytes: Int64
    public var entries: Int
    /// Entries `gc` would reclaim whose size it could not measure.
    public var unsized: Int
  }

  /// Owned devices `stim gc --delete` deletes.
  public var deletableDevices: [Device] {
    let s = sections
    return [s.parkedSimulators, s.parkedEmulators, s.orphanedDevices, s.staleDevices].flatMap { $0 ?? [] }
  }

  /// Build outputs `stim gc --delete` clears because their workspace is not in use.
  public var clearableOutputs: [BuildOutputs] {
    (sections.workspaceBuildOutputs ?? []).filter { $0.willClear == true }
  }

  /// Workspace logs `stim gc --delete` trims.
  public var trimmableLogs: [WorkspaceLogs] {
    (sections.workspaceLogs ?? []).filter(\.willTrim)
  }

  /// Linked worktrees `stim gc --delete` removes because their branch or pull request is merged, or their pull
  /// request was closed.
  public var mergedWorktrees: [LinkedWorktree] {
    (sections.linkedWorktrees ?? []).filter {
      $0.willRemove && ($0.mergedInto != nil || $0.pullRequest?.isFinished == true)
    }
  }

  public var reclaimable: Reclaimable {
    var removed: [Int64?] = (sections.orphanedWorkspaces ?? []).map(\.bytes)
    removed += deletableDevices.map(\.bytes)
    removed += clearableOutputs.map(\.bytes)
    removed += trimmableLogs.map(\.trimBytes)
    removed += (sections.caches ?? []).filter { $0.willEmpty == true }.map(\.bytes)
    return Reclaimable(
      bytes: removed.reduce(0) { $0 + ($1 ?? 0) },
      entries: removed.count,
      unsized: removed.filter { $0 == nil }.count)
  }
}
