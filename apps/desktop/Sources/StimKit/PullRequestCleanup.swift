import Foundation

/// The autopilot that removes worktrees whose pull request was merged or closed. A cheap `gh pr list` per
/// repository finds branches with a finished pull request; only then does it run `stim gc --json`, which
/// decides per worktree whether removal is safe, and `stim worktree remove` on each safe one.
public enum PullRequestCleanup {
  public static let pollInterval: TimeInterval = 5 * 60
  /// The shortest gap between two polls when the app becomes active.
  public static let focusInterval: TimeInterval = 60
  /// How long a `stim gc` verdict on the same candidates stands before it is asked again.
  public static let reportMaxAge: TimeInterval = 30 * 60

  /// `gh pr list` arguments for the repository's 100 newest merged and closed pull requests.
  public static let listArguments = [
    "pr", "list", "--state", "closed", "--limit", "100", "--json", "headRefName,isCrossRepository",
  ]

  /// Head branch names of the repository's own pull requests in `gh pr list --json` output, or nil when it is
  /// not that. A fork's pull request only shares the branch name, and `stim gc` ignores it too.
  public static func branches(_ json: Data) -> Set<String>? {
    struct Entry: Decodable {
      var headRefName: String
      var isCrossRepository: Bool?
    }
    return (try? JSONDecoder().decode([Entry].self, from: json)).map {
      Set($0.filter { $0.isCrossRepository != true }.map(\.headRefName))
    }
  }

  /// Why a check found no pull requests because `gh` could not answer, or nil when it answered for a repository.
  public static func problem(hasGitHubCLI: Bool, repositories: Int, answered: Int) -> String? {
    if !hasGitHubCLI { return "gh is not on the login shell's PATH, so no worktree is removed for its pull request." }
    if repositories > 0, answered == 0 {
      return "gh answered for no repository: it is signed out, offline, or no repository is on GitHub."
    }
    return nil
  }

  /// Paths of linked worktrees whose branch has a merged or closed pull request, by repository.
  public static func candidates(_ environments: [Workspace], finished: [String: Set<String>]) -> Set<String> {
    Set(
      environments.compactMap { env in
        guard let worktree = env.worktree, let repository = worktree.repository, worktree.path != repository,
          let branch = worktree.branch, finished[repository]?.contains(branch) == true
        else { return nil }
        return worktree.path
      })
  }

  /// Worktrees `stim gc` found safe to remove because their pull request was merged or closed.
  public static func removable(_ report: GcReport) -> [GcReport.LinkedWorktree] {
    (report.sections.linkedWorktrees ?? []).filter { $0.willRemove && $0.pullRequest?.isFinished == true }
  }

  /// The worktrees of `removable` that the latest `stim status` still shows on a branch with a finished pull
  /// request, not live and not building, so one that started Metro, a build or a device, or switched branches,
  /// since `stim gc --json` judged it waits for the next `stim gc` verdict.
  public static func stillRemovable(
    _ removable: [GcReport.LinkedWorktree], environments: [Workspace], finished: [String: Set<String>]
  ) -> [GcReport.LinkedWorktree] {
    let busy = environments.filter { $0.live || $0.build?.isRunning == true }
    let current = candidates(environments, finished: finished)
    let live = Set(busy.compactMap { $0.worktree?.path })
    return removable.filter { current.contains($0.path) && !live.contains($0.path) }
  }

  /// A worktree whose pull request was merged or closed that `stim gc` keeps, with the reason.
  public struct Flag: Hashable, Sendable {
    public var path: String
    public var pullRequest: GcReport.PullRequestState
    /// "PR #123 merged, 2 uncommitted or untracked files".
    public var text: String
  }

  /// Worktrees with a merged or closed pull request that are kept for a reason that needs a person. One waiting
  /// out the grace period after recent activity is left out: it is removed once that passes.
  public static func flagged(_ report: GcReport) -> [Flag] {
    (report.sections.linkedWorktrees ?? []).compactMap { worktree in
      guard let pr = worktree.pullRequest, pr.isFinished, !worktree.willRemove,
        worktree.reason != "recent-activity"
      else { return nil }
      return Flag(path: worktree.path, pullRequest: pr, text: "PR #\(pr.number) \(pr.state), \(keptBecause(worktree))")
    }
  }

  static func keptBecause(_ worktree: GcReport.LinkedWorktree) -> String {
    let detail = worktree.detail ?? worktree.reason ?? "kept"
    for prefix in ["dirty: ", "unpushed: "] where detail.hasPrefix(prefix) {
      return String(detail.dropFirst(prefix.count))
    }
    return detail
  }

  /// The earliest time a worktree with a finished pull request that is waiting out the grace period becomes
  /// removable, or nil.
  public static func nextEligible(_ report: GcReport) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return (report.sections.linkedWorktrees ?? []).compactMap { worktree -> Date? in
      guard worktree.pullRequest?.isFinished == true, worktree.reason == "recent-activity" else { return nil }
      return worktree.eligibleAt.flatMap { formatter.date(from: $0) }
    }.min()
  }

  /// "Removed 3 worktrees for merged PRs".
  public static func summary(_ removed: [GcReport.LinkedWorktree]) -> String {
    let states = Set(removed.compactMap(\.pullRequest?.state))
    let kind = states == ["merged"] ? "merged" : states == ["closed"] ? "closed" : "merged or closed"
    return "Removed \(removed.count == 1 ? "1 worktree" : "\(removed.count) worktrees") for \(kind) PRs"
  }
}

/// `gh` from the login shell's `PATH`.
public struct GitHubCLI: Sendable {
  public let executable: String?
  let environment: [String: String]

  public init(environment: [String: String]) {
    var environment = environment
    executable = resolveExecutable("gh", override: nil, environment: &environment)
    environment["GH_PROMPT_DISABLED"] = "1"
    environment["GH_NO_UPDATE_NOTIFIER"] = "1"
    self.environment = environment
  }

  /// Stdout of a run that exited 0 within `timeout`, else nil.
  public func run(_ arguments: [String], cwd: String, timeout: TimeInterval = 30) -> Data? {
    guard let executable else { return nil }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    process.environment = environment
    let out = Pipe()
    process.standardOutput = out
    process.standardError = FileHandle.nullDevice
    process.standardInput = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    let output = Output()
    let read = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .utility).async {
      output.data = out.fileHandleForReading.readDataToEndOfFile()
      read.signal()
    }
    if read.wait(timeout: .now() + timeout) == .timedOut {
      process.terminate()
      return nil
    }
    process.waitUntilExit()
    return process.terminationStatus == 0 ? output.data : nil
  }
}

private final class Output: @unchecked Sendable {
  var data = Data()
}
