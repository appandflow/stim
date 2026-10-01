import AppKit
import StimKit

/// The volumes Stim writes to, probed once for every reader: the machine metrics, the oversight notifications and
/// the autopilot. A reader takes the last probe while it started within the reader's `maxAge`, and otherwise joins
/// or starts a probe.
@MainActor
public final class DiskVolumeStore {
  public typealias Locations = [(label: String, path: String)]

  private let locations: @MainActor () -> Locations
  private let probe: @Sendable (Locations) async -> [DiskVolume]
  private let now: @MainActor () -> Date
  private var latest: (volumes: [DiskVolume], startedAt: Date)?
  private var task: (probe: Task<[DiskVolume], Never>, startedAt: Date)?

  init(
    locations: @escaping @MainActor () -> Locations, probe: @escaping @Sendable (Locations) async -> [DiskVolume],
    now: @escaping @MainActor () -> Date = { Date() }
  ) {
    self.locations = locations
    self.probe = probe
    self.now = now
  }

  public convenience init(status: StatusStore) {
    self.init(
      locations: { Self.stimLocations(status.payload?.environments ?? [], status: status) },
      probe: { locations in await Task.detached(priority: .utility) { DiskUsage.volumes(for: locations) }.value })
  }

  public func volumes(maxAge: TimeInterval) async -> [DiskVolume] {
    let now = now()
    if let latest, now.timeIntervalSince(latest.startedAt) <= maxAge { return latest.volumes }
    if let task, now.timeIntervalSince(task.startedAt) <= maxAge { return await task.probe.value }
    let locations = locations()
    let probe = probe
    let next = Task { [weak self] in
      let volumes = await probe(locations)
      self?.finish(volumes, startedAt: now)
      return volumes
    }
    task = (next, now)
    return await next.value
  }

  private func finish(_ volumes: [DiskVolume], startedAt: Date) {
    if latest.map({ $0.startedAt <= startedAt }) ?? true { latest = (volumes, startedAt) }
    if task?.startedAt == startedAt { task = nil }
  }

  static func stimLocations(_ workspaces: [Workspace], status: StatusStore) -> Locations {
    let home = NSHomeDirectory()
    let repositories = Set(workspaces.map { status.project(of: $0).root }).sorted()
    return repositories.map { (label: "Repositories", path: $0) } + [
      (label: "Stim home", path: status.stimHome),
      (label: "Simulators", path: "\(home)/Library/Developer/CoreSimulator"),
    ]
  }
}
