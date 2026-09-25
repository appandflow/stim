import Foundation
import StimKit

/// Disk sizes Stim Desktop measures itself with `du`, and open pull requests from `gh`. Both run in the
/// background at low priority and are kept for `maxAge`, so opening the Storage view never waits on them.
@MainActor
final class StorageStore: ObservableObject {
  static let maxAge: TimeInterval = 15 * 60
  nonisolated static let toolTimeout: TimeInterval = 30

  @Published private(set) var sizes: [String: Int64] = [:]
  @Published private(set) var measuredAt: Date?
  @Published private(set) var measuring = false
  /// Open pull requests by repository, then by head branch.
  @Published private(set) var pulls: [String: [String: PullRequest]] = [:]
  /// False when no `gh` is on the login shell's PATH.
  @Published private(set) var hasGitHubCLI: Bool?
  @Published private(set) var paths = StoragePaths(home: NSHomeDirectory())

  private let status: StatusStore
  private let cli: Task<StimCLI, Never>

  init(status: StatusStore, cli: Task<StimCLI, Never>) {
    self.status = status
    self.cli = cli
  }

  func refresh(force: Bool = false) {
    guard !measuring else { return }
    if !force, let at = measuredAt, Date().timeIntervalSince(at) < Self.maxAge { return }
    measuring = true
    let environments = status.payload?.environments ?? []
    let repositories = Set(environments.compactMap { $0.worktree?.repository })
    let cli = cli
    Task.detached(priority: .background) {
      let environment = await cli.value.environment
      let paths = StoragePaths(home: NSHomeDirectory(), environment: environment)
      let modules = Set(environments.map { "\($0.worktree?.path ?? $0.path)/node_modules" })
      let sizes = Self.du(["-k", "-d", "1"], paths.deviceSets).merging(
        Self.du(["-k", "-s"], modules.sorted() + paths.unmanaged.map(\.path)), uniquingKeysWith: { first, _ in first })
      let gh = Self.executable("gh", in: environment)
      let pulls = Dictionary(
        uniqueKeysWithValues: repositories.compactMap { repository -> (String, [String: PullRequest])? in
          guard let gh,
            let byBranch = Self.run(gh, PullRequest.listArguments, cwd: repository, environment: environment)
              .flatMap(PullRequest.byBranch)
          else { return nil }
          return (repository, byBranch)
        })
      await MainActor.run {
        self.paths = paths
        self.sizes = sizes
        self.pulls = pulls
        self.hasGitHubCLI = gh != nil
        self.measuredAt = Date()
        self.measuring = false
      }
    }
  }

  func pulls(for workspace: WorkspaceStorage) -> [String: PullRequest]? {
    workspace.repository.flatMap { pulls[$0] }
  }

  nonisolated private static func du(_ options: [String], _ paths: [String]) -> [String: Int64] {
    let existing = paths.filter { FileManager.default.fileExists(atPath: $0) }
    guard !existing.isEmpty,
      let output = run("/usr/bin/du", options + existing, cwd: NSHomeDirectory(), environment: nil, timeout: 600)
    else { return [:] }
    return DiskSizes.parse(String(decoding: output, as: UTF8.self))
  }

  nonisolated private static func executable(_ name: String, in environment: [String: String]) -> String? {
    (environment["PATH"] ?? "").split(separator: ":").lazy.map { "\($0)/\(name)" }
      .first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  /// Stdout of a finished run, or nil when it could not start or ran past `timeout`. `du` exits 1 after
  /// an unreadable entry but still prints the rest, so the status is not checked.
  nonisolated private static func run(
    _ executable: String, _ arguments: [String], cwd: String, environment: [String: String]?,
    timeout: TimeInterval = toolTimeout
  ) -> Data? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    if let environment { process.environment = environment }
    process.qualityOfService = .background
    let out = Pipe()
    process.standardOutput = out
    process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    let box = DataBox()
    let read = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .background).async {
      box.value = out.fileHandleForReading.readDataToEndOfFile()
      read.signal()
    }
    if read.wait(timeout: .now() + timeout) == .timedOut {
      process.terminate()
      return nil
    }
    process.waitUntilExit()
    return box.value
  }
}

private final class DataBox: @unchecked Sendable {
  var value = Data()
}
