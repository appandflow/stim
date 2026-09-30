import Foundation

/// The session's runs, newest first, for the sidebar footer's operations item: which are in flight, which
/// recent ones ended badly and were not looked at, and a bounded history. It is separate from `ActionCenter`
/// so the footer item observes only this, never the workspace views' run changes.
@MainActor
public final class OperationLog: ObservableObject {
  /// Finished runs kept besides the running ones.
  public static let retainedFinished = 20

  @Published public private(set) var runs: [ActionRun] = []
  @Published public private(set) var unseen: Set<UUID> = []

  public init() {}

  public var running: [ActionRun] { runs.filter(\.isRunning) }

  /// Finished runs that failed or left failures, and that nobody opened since.
  public var attentionCount: Int { runs.filter { unseen.contains($0.id) }.count }

  public func began(_ run: ActionRun) {
    runs.insert(run, at: 0)
    trim()
  }

  /// `viewed` is true when the run's sheet is open as it ends, so it cannot go unnoticed.
  public func finished(_ run: ActionRun, viewed: Bool) {
    objectWillChange.send()
    if !viewed, run.needsAttention { unseen.insert(run.id) }
    trim()
  }

  public func markSeen(_ run: ActionRun) {
    if unseen.contains(run.id) { unseen.remove(run.id) }
  }

  public func markAllSeen() {
    if !unseen.isEmpty { unseen = [] }
  }

  private func trim() {
    var finished = 0
    runs.removeAll { run in
      guard !run.isRunning else { return false }
      finished += 1
      return finished > Self.retainedFinished
    }
    unseen.formIntersection(runs.map(\.id))
  }
}
