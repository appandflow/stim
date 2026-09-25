import Combine
import Foundation

/// Next-build predictions per workspace and platform, shared by every view that shows them.
/// A workspace runs one plan at a time, and a result stays current for `freshFor` seconds
/// while its platform's last build is unchanged.
@MainActor
public final class BuildPlanChecks: ObservableObject {
  public enum State: Equatable, Sendable {
    case checking
    case done(BuildPlanOutcome)
    case failed(String)
  }

  public struct Entry: Equatable, Sendable {
    public var state: State
    /// The `LastBuild.planKey` the check ran against.
    public var buildKey: String
    public var checkedAt: Date?
  }

  public typealias Planner = @Sendable (_ platform: String, _ workspace: String) async throws -> BuildPlanOutcome

  public static let freshFor: TimeInterval = 60

  @Published public private(set) var entries: [String: Entry] = [:]
  private var tasks: [String: Task<Void, Never>] = [:]
  private var queues: [String: Task<Void, Never>] = [:]
  private let planner: Planner
  private let now: () -> Date

  public init(planner: @escaping Planner, now: @escaping () -> Date = Date.init) {
    self.planner = planner
    self.now = now
  }

  public func entry(workspace: String, platform: String) -> Entry? {
    entries[Self.key(workspace, platform)]
  }

  /// Plans each platform, keyed by its last build, unless a check for that build is running or fresh.
  /// `force` re-runs a fresh result.
  public func check(workspace: String, builds: [String: String], force: Bool = false) {
    for platform in builds.keys.sorted() {
      let buildKey = builds[platform]!
      let key = Self.key(workspace, platform)
      if let entry = entries[key], entry.buildKey == buildKey {
        if entry.state == .checking { continue }
        if !force, let at = entry.checkedAt, now().timeIntervalSince(at) < Self.freshFor { continue }
      }
      tasks[key]?.cancel()
      entries[key] = Entry(state: .checking, buildKey: buildKey, checkedAt: nil)
      let previous = queues[workspace]
      let task = Task { [planner] in
        await previous?.value
        guard !Task.isCancelled else { return }
        let state: State
        do {
          state = .done(try await planner(platform, workspace))
        } catch {
          state = .failed(error.localizedDescription)
        }
        guard !Task.isCancelled else { return }
        self.entries[key] = Entry(state: state, buildKey: buildKey, checkedAt: self.now())
        self.tasks[key] = nil
      }
      tasks[key] = task
      queues[workspace] = task
    }
  }

  /// Stops the workspace's running and queued checks and forgets them; finished results stay.
  public func cancel(workspace: String) {
    for platform in ["ios", "android"] {
      let key = Self.key(workspace, platform)
      guard let task = tasks.removeValue(forKey: key) else { continue }
      task.cancel()
      if entries[key]?.state == .checking { entries[key] = nil }
    }
  }

  private static func key(_ workspace: String, _ platform: String) -> String { "\(workspace)\n\(platform)" }
}

extension LastBuild {
  /// Changes whenever this platform's last build record changes.
  public var planKey: String { "\(startedAt)|\(finishedAt ?? "")|\(status)" }
}
