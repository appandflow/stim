import AppKit
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
  @Published private(set) var gcReport: GcReport?
  @Published private(set) var gcRunning = false
  @Published private(set) var gcAt: Date?

  private let status: StatusStore
  private let cli: Task<StimCLI, Never>
  private var sampler = ResourceSampler()
  private var timer: Timer?
  private var sampling = false

  init(status: StatusStore, cli: Task<StimCLI, Never>) {
    self.status = status
    self.cli = cli
  }

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

  var totalResident: Int64 {
    usage.values.reduce(0) { $0 + $1.latest.residentBytes }
  }

  private var onScreen: Bool {
    NSApp.isActive && NSApp.windows.contains { $0.isVisible && $0.occlusionState.contains(.visible) }
  }

  private func tick() {
    guard onScreen else { return }
    sample()
    if !gcRunning, gcAt.map({ Date().timeIntervalSince($0) > 300 }) ?? true { refreshGc() }
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
      }
    }
  }

  func refreshGc() {
    guard !gcRunning else { return }
    gcRunning = true
    let cli = cli
    Task.detached {
      let report = try? await cli.value.gcReport()
      await MainActor.run {
        self.gcRunning = false
        self.gcAt = Date()
        self.gcReport = report
      }
    }
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

func formatDisk(_ bytes: Int64) -> String {
  ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
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
