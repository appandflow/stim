import AppKit
import StimKit
import StimStores

/// Disk sizes Stim Desktop measures itself with `du`, except the node_modules sizes `stim status` already reports.
/// Each path is sized by its own `du` and published as it finishes, so one slow tree delays only its own row.
/// Results are kept for `maxAge`, so opening the Storage view never waits on them.
@MainActor
final class StorageStore: ObservableObject {
  static let maxAge: TimeInterval = 15 * 60
  nonisolated static let duTimeout: TimeInterval = 180
  nonisolated static let duConcurrency = 3
  nonisolated private static let running = ProcessRegistry()

  @Published private(set) var disk = DiskMeasurements()
  @Published private(set) var measuredAt: Date?
  @Published private(set) var paths = StoragePaths(home: NSHomeDirectory())

  private let status: StatusStore
  private let environment: Task<[String: String], Never>
  private let terminationObserver: NSObjectProtocol

  var measuring: Bool { !disk.pending.isEmpty }

  init(status: StatusStore, environment: Task<[String: String], Never>) {
    self.status = status
    self.environment = environment
    terminationObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.willTerminateNotification, object: nil, queue: nil
    ) { _ in Self.running.terminateAll() }
  }

  deinit {
    NotificationCenter.default.removeObserver(terminationObserver)
  }

  func refresh(force: Bool = false) {
    guard !measuring else { return }
    if !force, let at = measuredAt, Date().timeIntervalSince(at) < Self.maxAge { return }
    let environments = status.payload?.environments ?? []
    let unprovisioned = status.payload?.unprovisionedWorktrees ?? []
    let modules = Set(
      environments.filter { $0.statusNodeModules == nil }.map { "\($0.worktree?.path ?? $0.path)/node_modules" }
        + unprovisioned.map { "\($0.path)/node_modules" })
    disk = DiskMeasurements(pending: Set(modules))
    let environment = environment
    Task {
      let environment = await environment.value
      let paths = StoragePaths(home: NSHomeDirectory(), environment: environment)
      self.paths = paths
      let jobs =
        paths.deviceSets.map { (path: $0.path, options: ["-k", "-d", "\($0.depth)"]) }
        + (modules.sorted() + paths.unmanaged.map(\.path)).map { (path: $0, options: ["-k", "-s"]) }
      let absent = await Task.detached { Set(jobs.map(\.path).filter { !FileManager.default.fileExists(atPath: $0) }) }.value
      disk = DiskMeasurements(pending: Set(jobs.map(\.path)).subtracting(absent), absent: absent)
      await measure(jobs.filter { !absent.contains($0.path) })
      measuredAt = Date()
    }
  }

  private func measure(_ jobs: [(path: String, options: [String])]) async {
    await withTaskGroup(of: (String, [String: Int64]).self) { group in
      var queue = jobs[...]
      func next() {
        guard let job = queue.popFirst() else { return }
        group.addTask {
          var request = ProcessRequest(
            "/usr/bin/du", job.options + [job.path], cwd: NSHomeDirectory(), timeout: Self.duTimeout)
          request.qualityOfService = .default
          request.registry = Self.running
          let result = try? await request.run()
          return (job.path, DiskSizes.parse(result?.stdoutText ?? ""))
        }
      }
      for _ in 0..<Self.duConcurrency { next() }
      for await (path, sizes) in group {
        disk.sizes.merge(sizes, uniquingKeysWith: { _, new in new })
        disk.pending.remove(path)
        if sizes[path] == nil { disk.failed.insert(path) }
        next()
      }
    }
  }
}
