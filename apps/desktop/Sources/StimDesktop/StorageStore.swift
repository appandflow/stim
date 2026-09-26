import Foundation
import StimKit

/// Disk sizes Stim Desktop measures itself with `du`, and open pull requests from `gh`. Each path is sized by
/// its own `du` and published as it finishes, so one slow tree delays only its own row. Results are kept for
/// `maxAge`, so opening the Storage view never waits on them.
@MainActor
final class StorageStore: ObservableObject {
  static let maxAge: TimeInterval = 15 * 60
  nonisolated static let toolTimeout: TimeInterval = 30
  nonisolated static let duTimeout: TimeInterval = 180
  nonisolated static let duConcurrency = 3

  @Published private(set) var disk = DiskMeasurements()
  @Published private(set) var measuredAt: Date?
  @Published private(set) var loadingPulls = false
  /// Open pull requests by repository, then by head branch.
  @Published private(set) var pulls: [String: [String: PullRequest]] = [:]
  /// False when no `gh` is on the login shell's PATH.
  @Published private(set) var hasGitHubCLI: Bool?
  @Published private(set) var paths = StoragePaths(home: NSHomeDirectory())

  private let status: StatusStore
  private let cli: Task<StimCLI, Never>

  var measuring: Bool { !disk.pending.isEmpty || loadingPulls }

  init(status: StatusStore, cli: Task<StimCLI, Never>) {
    self.status = status
    self.cli = cli
  }

  func refresh(force: Bool = false) {
    guard !measuring else { return }
    if !force, let at = measuredAt, Date().timeIntervalSince(at) < Self.maxAge { return }
    let environments = status.payload?.environments ?? []
    let unprovisioned = status.payload?.unprovisionedWorktrees ?? []
    let repositories = Set(environments.compactMap { $0.worktree?.repository } + unprovisioned.compactMap(\.repository))
    let modules = Set(
      environments.map { "\($0.worktree?.path ?? $0.path)/node_modules" } + unprovisioned.map { "\($0.path)/node_modules" })
    loadingPulls = true
    disk = DiskMeasurements(pending: Set(modules))
    let cli = cli
    Task {
      let environment = await cli.value.environment
      let paths = StoragePaths(home: NSHomeDirectory(), environment: environment)
      self.paths = paths
      let jobs =
        paths.deviceSets.map { (path: $0, options: ["-k", "-d", "1"]) }
        + (modules.sorted() + paths.unmanaged.map(\.path)).map { (path: $0, options: ["-k", "-s"]) }
      let absent = await Task.detached { Set(jobs.map(\.path).filter { !FileManager.default.fileExists(atPath: $0) }) }.value
      disk = DiskMeasurements(pending: Set(jobs.map(\.path)).subtracting(absent), absent: absent)
      async let sized: Void = measure(jobs.filter { !absent.contains($0.path) })
      async let pulled: Void = loadPulls(repositories: repositories, environment: environment)
      _ = await (sized, pulled)
      measuredAt = Date()
    }
  }

  private func measure(_ jobs: [(path: String, options: [String])]) async {
    await withTaskGroup(of: (String, [String: Int64]).self) { group in
      var queue = jobs[...]
      func next() {
        guard let job = queue.popFirst() else { return }
        group.addTask {
          let result = await Self.offThread {
            Self.run("/usr/bin/du", job.options + [job.path], cwd: NSHomeDirectory(), environment: nil, timeout: Self.duTimeout)
          }
          return (job.path, DiskSizes.parse(String(decoding: result?.output ?? Data(), as: UTF8.self)))
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

  private func loadPulls(repositories: Set<String>, environment: [String: String]) async {
    let (gh, pulls) = await Self.offThread {
      let gh = Self.executable("gh", in: environment)
      let pulls = Dictionary(
        uniqueKeysWithValues: repositories.compactMap { repository -> (String, [String: PullRequest])? in
          guard let gh,
            let byBranch = Self.run(gh, PullRequest.listArguments, cwd: repository, environment: environment)
              .flatMap({ $0.timedOut ? nil : PullRequest.byBranch($0.output) })
          else { return nil }
          return (repository, byBranch)
        })
      return (gh, pulls)
    }
    self.pulls = pulls
    hasGitHubCLI = gh != nil
    loadingPulls = false
  }

  func pulls(for workspace: WorkspaceStorage) -> [String: PullRequest]? {
    workspace.repository.flatMap { pulls[$0] }
  }

  nonisolated private static func executable(_ name: String, in environment: [String: String]) -> String? {
    (environment["PATH"] ?? "").split(separator: ":").lazy.map { "\($0)/\(name)" }
      .first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  /// Runs blocking work on a dispatch queue, so waiting on a child process never holds a Swift concurrency thread.
  nonisolated private static func offThread<T: Sendable>(_ work: @escaping @Sendable () -> T) async -> T {
    await withCheckedContinuation { continuation in
      DispatchQueue.global(qos: .utility).async { continuation.resume(returning: work()) }
    }
  }

  /// Stdout of a run and whether it ran past `timeout` and was terminated, or nil when it could not start. A
  /// terminated `du -d 1` has already printed the entries it finished, and `du` exits 1 after an unreadable
  /// entry but still prints the rest, so neither case discards the output. The child runs at utility QoS: at
  /// background QoS macOS throttles its disk I/O, which made `du` over a large node_modules about 16 times slower.
  nonisolated private static func run(
    _ executable: String, _ arguments: [String], cwd: String, environment: [String: String]?,
    timeout: TimeInterval = toolTimeout
  ) -> (output: Data, timedOut: Bool)? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    if let environment { process.environment = environment }
    process.qualityOfService = .utility
    let out = Pipe()
    process.standardOutput = out
    process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    let box = DataBox()
    let read = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .utility).async {
      box.value = out.fileHandleForReading.readDataToEndOfFile()
      read.signal()
    }
    guard read.wait(timeout: .now() + timeout) == .timedOut else {
      process.waitUntilExit()
      return (box.value, false)
    }
    process.terminate()
    if read.wait(timeout: .now() + 5) == .timedOut {
      kill(process.processIdentifier, SIGKILL)
      guard read.wait(timeout: .now() + 5) == .success else { return (Data(), true) }
    }
    return (box.value, true)
  }
}

private final class DataBox: @unchecked Sendable {
  var value = Data()
}
