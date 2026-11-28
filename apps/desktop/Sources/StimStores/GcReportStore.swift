import AppKit
import Observation
import StimKit

/// The GC dry-run report the Machine page and the metrics share. At most one read is in
/// flight; a caller that asks while it runs gets its result. The server answers from its last
/// report and measures again in the background, so `running` also covers that measurement.
@MainActor @Observable
public final class GcReportStore {
  public private(set) var latest = Fetched<GcReport>()
  /// When the shown report was measured.
  public private(set) var at: Date?
  public private(set) var running = false

  private let run: @Sendable (_ fresh: Bool) async throws -> GcReportRead
  private let now: @MainActor () -> Date
  private let settleDelay: TimeInterval
  @ObservationIgnored private var task: Task<GcReport?, Never>?
  @ObservationIgnored private var taskStartedAt = Date.distantPast
  @ObservationIgnored private var changedAt = Date.distantPast
  @ObservationIgnored private var settle: Timer?
  @ObservationIgnored private var taskFresh = false
  @ObservationIgnored private var refreshing = false
  @ObservationIgnored private var polledAt: Date?
  @ObservationIgnored private var failures = 0

  init(
    read: @escaping @Sendable (_ fresh: Bool) async throws -> GcReportRead,
    now: @escaping @MainActor () -> Date = { Date() }, settleDelay: TimeInterval = 2
  ) {
    self.run = read
    self.now = now
    self.settleDelay = settleDelay
  }

  convenience init(
    run: @escaping @Sendable () async throws -> GcReport, now: @escaping @MainActor () -> Date = { Date() },
    settleDelay: TimeInterval = 2
  ) {
    self.init(
      read: { _ in GcReportRead(report: try await run(), measuredAt: nil, refreshing: false) }, now: now,
      settleDelay: settleDelay)
  }

  public convenience init(reader: GcReportReader) {
    self.init(read: { fresh in try await reader.refresh(fresh: fresh) })
  }

  #if DEBUG
    public convenience init(fixture: GcReport) {
      self.init(run: { fixture })
      latest.record(.success(fixture))
    }
  #endif

  public var report: GcReport? { latest.value }
  public var error: String? { latest.error }

  /// The last report while it is younger than `maxAge` and no action changed what it reports since it started;
  /// otherwise the result of a run that started after that change, nil when that run fails.
  public func report(maxAge: TimeInterval) async -> GcReport? {
    if let report, let at, at >= changedAt, now().timeIntervalSince(at) < maxAge { return report }
    return await current(fresh: true).value
  }

  /// Asks the server to measure again, joining a measurement already under way.
  public func refresh() {
    _ = current(fresh: true)
  }

  /// Reads the server's current report without asking for a new measurement: every 15 seconds while it measures,
  /// has none yet or the last read failed, doubling after each failure up to 5 minutes, and every 5 minutes otherwise.
  public func poll() {
    guard task == nil else { return }
    let waiting = refreshing || report == nil || failures > 0
    let interval = waiting ? min(Self.slowPoll, Self.fastPoll * pow(2, Double(failures))) : Self.slowPoll
    if let polledAt, now().timeIntervalSince(polledAt) < interval { return }
    _ = current(fresh: false)
  }

  private static let fastPoll: TimeInterval = 15
  private static let slowPoll: TimeInterval = 300

  /// Marks the report stale after an action that can change it, and runs gc once actions have settled for
  /// `settleDelay`, unless a run has started since.
  public func changed() {
    changedAt = now()
    settle?.invalidate()
    settle = Timer.scheduledTimer(withTimeInterval: settleDelay, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.task == nil || self.taskStartedAt < self.changedAt else { return }
        if let at = self.at, at >= self.changedAt { return }
        self.refresh()
      }
    }
  }

  private func current(fresh: Bool) -> Task<GcReport?, Never> {
    if let task, taskFresh || !fresh, taskStartedAt >= changedAt { return task }
    let previous = task
    let startedAt = now()
    let run = run
    let next = Task { [weak self] () -> GcReport? in
      _ = await previous?.value
      let result = await Result.awaiting { try await run(fresh) }
      self?.finish(result, startedAt: startedAt)
      return try? result.get().report
    }
    task = next
    taskStartedAt = startedAt
    taskFresh = fresh
    polledAt = startedAt
    running = true
    return next
  }

  private func finish(_ result: Result<GcReportRead, any Error>, startedAt: Date) {
    switch result {
    case .success(let read):
      failures = 0
      refreshing = read.refreshing
      if let report = read.report {
        latest.record(.success(report))
        at = read.measuredAt ?? startedAt
      }
    case .failure(let error):
      failures += 1
      refreshing = false
      latest.record(.failure(error))
    }
    guard startedAt == taskStartedAt else { return }
    task = nil
    running = refreshing
  }
}
