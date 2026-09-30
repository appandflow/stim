import AppKit
import Observation
import StimKit
import StimStores

struct UsageHistory {
  static let limit = 40

  var latest: ResourceUsage
  /// The latest memory figure: the status footprint when `stim` measured one, else the sampled resident size.
  var memoryBytes: Int64 = 0
  var isFootprint = false
  var cpu: [Double] = []
  var memory: [Double] = []

  mutating func append(_ usage: ResourceUsage, footprintBytes: Int64?) {
    latest = usage
    memoryBytes = footprintBytes ?? usage.residentBytes
    if (footprintBytes != nil) != isFootprint { memory = [] }
    isFootprint = footprintBytes != nil
    if let percent = usage.cpuPercent { cpu = Array((cpu + [percent]).suffix(Self.limit)) }
    memory = Array((memory + [Double(memoryBytes)]).suffix(Self.limit))
  }
}

@MainActor @Observable
final class MetricsStore {
  private(set) var usage: [String: UsageHistory] = [:]
  private(set) var volumes: [DiskVolume] = []
  private(set) var memory: MachineMemory?
  /// Samples of the Mac's memory in use and of the CPU the status `machine` owners use, oldest first.
  private(set) var memoryUsed: [Double] = []
  private(set) var ownersCpu: [Double] = []
  private(set) var owners = OwnerHistory()

  private let status: StatusStore
  private let gc: GcReportStore
  @ObservationIgnored private var sampler = ResourceSampler()
  @ObservationIgnored private var timer: Timer?
  @ObservationIgnored private var sampling = false

  init(status: StatusStore, gc: GcReportStore) {
    self.status = status
    self.gc = gc
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

  private static var cores: Int { ProcessInfo.processInfo.activeProcessorCount }

  /// The share of the Mac's CPU that every live workspace's processes use, from 0 to 1.
  var totalCpuFraction: Double? {
    let values = usage.values.compactMap(\.latest.cpuPercent)
    return values.isEmpty
      ? nil : UsageThresholds.cpuFraction(percentOfOneCore: values.reduce(0, +), cores: Self.cores)
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
        let footprints = Dictionary(
          (self.status.payload?.environments ?? []).compactMap { env in env.footprintBytes.map { (env.path, $0) } },
          uniquingKeysWith: { first, _ in first })
        for (path, value) in result {
          var history = self.usage[path] ?? UsageHistory(latest: value)
          history.append(value, footprintBytes: footprints[path])
          next[path] = history
        }
        self.usage = next
        self.volumes = volumes
        self.memory = memory
        if let memory { self.memoryUsed = Array((self.memoryUsed + [Double(memory.usedBytes)]).suffix(UsageHistory.limit)) }
        self.owners.append(self.status.payload?.machine, at: Date())
        if let machine = self.status.payload?.machine {
          let share = 100 * UsageThresholds.cpuFraction(percentOfOneCore: machine.cpuPercent, cores: Self.cores)
          self.ownersCpu = Array((self.ownersCpu + [share]).suffix(UsageHistory.limit))
        } else {
          self.ownersCpu = []
        }
      }
    }
  }
}

@MainActor
func stimDiskLocations(_ workspaces: [Workspace], status: StatusStore) -> [(label: String, path: String)] {
  let home = NSHomeDirectory()
  let repositories = Set(workspaces.map { status.project(of: $0).root }).sorted()
  return repositories.map { (label: "Repositories", path: $0) } + [
    (label: "Stim home", path: status.stimHome),
    (label: "Simulators", path: "\(home)/Library/Developer/CoreSimulator"),
  ]
}

func formatPercent(_ percent: Double) -> String {
  "\(Int(percent.rounded()))%"
}
