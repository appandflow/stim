import AppKit
import Combine
import StimKit

struct UsageHistory {
  static let limit = 40

  var latest: ResourceUsage
  var cpu: [Double] = []
  var resident: [Double] = []

  mutating func append(_ usage: ResourceUsage) {
    latest = usage
    if let percent = usage.cpuPercent { cpu = Array((cpu + [percent]).suffix(Self.limit)) }
    resident = Array((resident + [Double(usage.residentBytes)]).suffix(Self.limit))
  }
}

@MainActor
final class MetricsStore: ObservableObject {
  @Published private(set) var usage: [String: UsageHistory] = [:]
  @Published private(set) var volumes: [DiskVolume] = []
  @Published private(set) var memory: MachineMemory?
  /// Samples of the Mac's memory in use and of the CPU the status `machine` owners use, oldest first.
  @Published private(set) var memoryUsed: [Double] = []
  @Published private(set) var ownersCpu: [Double] = []

  private let status: StatusStore
  let gc: GcReportStore
  private var sampler = ResourceSampler()
  private var timer: Timer?
  private var sampling = false
  private var relay: AnyCancellable?

  init(status: StatusStore, gc: GcReportStore) {
    self.status = status
    self.gc = gc
    relay = gc.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
  }

  var gcReport: GcReport? { gc.report }
  var gcRunning: Bool { gc.running }

  func start() {
    guard timer == nil else { return }
    tick()
    timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.tick() }
    }
    NotificationCenter.default.addObserver(
      forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.tick() }
    }
  }

  var reclaimable: GcReport.Reclaimable? { gcReport?.reclaimable }

  var totalCpu: Double? {
    let values = usage.values.compactMap(\.latest.cpuPercent)
    return values.isEmpty ? nil : values.reduce(0, +)
  }

  var totalCpuFraction: Double {
    guard let cpu = totalCpu else { return 0 }
    return cpu / (100 * Double(max(1, ProcessInfo.processInfo.activeProcessorCount)))
  }

  var totalResident: Int64 {
    usage.values.reduce(0) { $0 + $1.latest.residentBytes }
  }

  private var onScreen: Bool {
    NSApp.isActive && NSApp.windows.contains { $0.isVisible && $0.occlusionState.contains(.visible) }
  }

  private func tick() {
    guard onScreen else { return }
    sample()
    if !gc.running, gc.at.map({ Date().timeIntervalSince($0) > 300 }) ?? true { gc.refresh() }
  }

  private func sample() {
    guard !sampling, let payload = status.payload else { return }
    sampling = true
    let workspaces = payload.environments
    let locations = stimDiskLocations(workspaces, status: status)
    let base = sampler
    Task.detached {
      let processes = (try? ProcessTable.snapshot()) ?? []
      var sampler = base
      let result = processes.isEmpty ? [:] : sampler.sample(workspaces, processes: processes, at: Date())
      let volumes = DiskUsage.volumes(for: locations)
      let memory = MachineMemory.read()
      let updated = processes.isEmpty ? nil : sampler
      await MainActor.run {
        self.sampling = false
        if let updated { self.sampler = updated }
        var next: [String: UsageHistory] = [:]
        for (path, value) in result {
          var history = self.usage[path] ?? UsageHistory(latest: value)
          history.append(value)
          next[path] = history
        }
        self.usage = next
        self.volumes = volumes
        self.memory = memory
        if let memory { self.memoryUsed = Array((self.memoryUsed + [Double(memory.usedBytes)]).suffix(UsageHistory.limit)) }
        if let machine = self.status.payload?.machine {
          self.ownersCpu = Array((self.ownersCpu + [machine.cpuPercent]).suffix(UsageHistory.limit))
        } else {
          self.ownersCpu = []
        }
      }
    }
  }

  func refreshGc() {
    gc.refresh()
  }
}

@MainActor
func stimDiskLocations(_ workspaces: [Workspace], status: StatusStore) -> [(label: String, path: String)] {
  let home = NSHomeDirectory()
  let stimHome = ProcessInfo.processInfo.environment["STIM_HOME"] ?? "\(home)/.stim"
  let repositories = Set(workspaces.map { status.project(of: $0).root }).sorted()
  return repositories.map { (label: "Repositories", path: $0) } + [
    (label: "Stim home", path: stimHome),
    (label: "Simulators", path: "\(home)/Library/Developer/CoreSimulator"),
  ]
}

func formatMemory(_ bytes: Int64) -> String {
  ByteCountFormatter.string(fromByteCount: bytes, countStyle: .memory)
}

private let diskFormatter: ByteCountFormatter = {
  let formatter = ByteCountFormatter()
  formatter.countStyle = .file
  formatter.allowsNonnumericFormatting = false
  return formatter
}()

func formatDisk(_ bytes: Int64) -> String {
  diskFormatter.string(fromByteCount: bytes)
}

func formatPercent(_ percent: Double) -> String {
  "\(Int(percent.rounded()))%"
}

func formatAgo(_ seconds: TimeInterval) -> String {
  let minutes = Int(seconds / 60)
  if minutes < 1 { return "just now" }
  if minutes < 60 { return "\(minutes)m ago" }
  return "\(minutes / 60)h ago"
}
