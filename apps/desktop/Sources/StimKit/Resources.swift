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
    public var willRemove: Bool
    public var detail: String?
  }

  public struct BuildOutputs: Decodable, Hashable, Sendable {
    public var dir: String?
    public var projectRoot: String?
    public var bytes: Int64?
    public var idleDays: Int?
    public var willClear: Bool?
    public var detail: String?
  }

  public struct Cache: Decodable, Hashable, Sendable {
    public var name: String
    public var dir: String
    public var bytes: Int64?
    public var note: String?
    public var willEmpty: Bool?

    /// Whether `stim gc --cache <name>` selects this cache alone. The CLI matches the argument as a
    /// case-insensitive substring of every cache's name and directory, and reserves `all` and `workspaces`.
    public func selectedAlone(among caches: [Cache]) -> Bool {
      let wanted = name.trimmingCharacters(in: .whitespaces).lowercased()
      guard !wanted.isEmpty, wanted != "all", wanted != "workspaces" else { return false }
      return caches.filter { $0.name.lowercased().contains(wanted) || $0.dir.lowercased().contains(wanted) }.count == 1
    }
  }

  public struct Sections: Decodable, Sendable {
    public var orphanedWorkspaces: [Sized]?
    public var linkedWorktrees: [LinkedWorktree]?
    public var parkedSimulators: [Device]?
    public var parkedEmulators: [Device]?
    public var orphanedDevices: [Device]?
    public var staleDevices: [Device]?
    public var workspaceBuildOutputs: [BuildOutputs]?
    public var caches: [Cache]?
  }

  public var sections: Sections

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

  /// Linked worktrees `stim gc --delete` removes because their branch is merged.
  public var mergedWorktrees: [LinkedWorktree] {
    (sections.linkedWorktrees ?? []).filter { $0.willRemove && $0.mergedInto != nil }
  }

  public var reclaimable: Reclaimable {
    var removed: [Int64?] = (sections.orphanedWorkspaces ?? []).map(\.bytes)
    removed += deletableDevices.map(\.bytes)
    removed += clearableOutputs.map(\.bytes)
    removed += (sections.caches ?? []).filter { $0.willEmpty == true }.map(\.bytes)
    return Reclaimable(
      bytes: removed.reduce(0) { $0 + ($1 ?? 0) },
      entries: removed.count,
      unsized: removed.filter { $0 == nil }.count)
  }
}
