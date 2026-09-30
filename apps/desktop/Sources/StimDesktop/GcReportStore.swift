import AppKit
import Observation
import StimKit

/// The one `stim gc --json` report the Machine page, the metrics and the autopilot share. At most one run is in
/// flight; a caller that asks while it runs gets its result.
@MainActor @Observable
final class GcReportStore {
  static let settleDelay: TimeInterval = 2

  private(set) var latest = Fetched<GcReport>()
  private(set) var at: Date?
  private(set) var running = false

  private let cli: Task<StimCLI, Never>
  @ObservationIgnored private var task: Task<GcReport?, Never>?
  @ObservationIgnored private var taskStartedAt = Date.distantPast
  @ObservationIgnored private var changedAt = Date.distantPast
  @ObservationIgnored private var settle: Timer?

  init(cli: Task<StimCLI, Never>) {
    self.cli = cli
  }

  var report: GcReport? { latest.value }
  var error: String? { latest.error }

  /// The last report while it is younger than `maxAge` and no action changed what it reports since it started;
  /// otherwise the result of a run that started after that change, nil when that run fails.
  func report(maxAge: TimeInterval) async -> GcReport? {
    if let report, let at, at >= changedAt, Date().timeIntervalSince(at) < maxAge { return report }
    return await current().value
  }

  /// The result of a run that started at or after `date`, so it saw everything that happened before then.
  func report(startedAfter date: Date) async -> GcReport? {
    if let report, let at, at >= max(changedAt, date) { return report }
    return await current(after: date).value
  }

  func refresh() {
    _ = current()
  }

  /// Marks the report stale after an action that can change it, and runs gc once actions have settled for
  /// `settleDelay`, unless a run has started since.
  func changed() {
    changedAt = Date()
    settle?.invalidate()
    settle = Timer.scheduledTimer(withTimeInterval: Self.settleDelay, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.task == nil || self.taskStartedAt < self.changedAt else { return }
        if let at = self.at, at >= self.changedAt { return }
        self.refresh()
      }
    }
  }

  private func current(after date: Date = .distantPast) -> Task<GcReport?, Never> {
    if let task, taskStartedAt >= max(changedAt, date) { return task }
    let previous = task
    let startedAt = Date()
    let cli = cli
    let next = Task { [weak self] () -> GcReport? in
      _ = await previous?.value
      let result = await Result.awaiting { try await cli.value.gcReport() }
      self?.finish(result, startedAt: startedAt)
      return try? result.get()
    }
    task = next
    taskStartedAt = startedAt
    running = true
    return next
  }

  private func finish(_ result: Result<GcReport, any Error>, startedAt: Date) {
    latest.record(result)
    if case .success = result { at = startedAt }
    guard startedAt == taskStartedAt else { return }
    task = nil
    running = false
  }
}
