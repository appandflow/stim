import Foundation

@MainActor
public final class OperationLog: ObservableObject {
  public static let retainedFinished = 20

  @Published public private(set) var runs: [ActionRun] = []
  @Published public private(set) var unseen: Set<UUID> = []

  public init() {}

  public var running: [ActionRun] { runs.filter(\.isRunning) }
  public var attentionCount: Int { runs.filter { unseen.contains($0.id) }.count }

  public func began(_ run: ActionRun) {
    runs.insert(run, at: 0)
    trim()
  }
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
