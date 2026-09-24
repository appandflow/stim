import AppKit
import StimKit

/// The records of one running `stim logs --follow` query, capped at `limit`
/// with the oldest dropped first.
@MainActor
final class LogsModel: ObservableObject {
  static let limit = 50_000

  enum Phase: Equatable {
    case idle
    case following
    case ended(String)
  }

  enum Change {
    case reset
    case appended
    /// This many rows were removed from the front.
    case trimmed(Int)
    case jumpToLatest
  }

  private(set) var records: [LogRecord] = []
  @Published private(set) var count = 0
  @Published private(set) var phase = Phase.idle
  @Published var pinnedToLatest = true
  var onChange: ((Change) -> Void)?

  private var session = 0
  private var terminationObserver: NSObjectProtocol?
  private lazy var follower = LogFollower { [weak self] event in self?.handle(event) }

  init() {
    terminationObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.willTerminateNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.follower.stop() }
    }
  }

  deinit {
    if let terminationObserver { NotificationCenter.default.removeObserver(terminationObserver) }
  }

  /// Replaces the running query. Pass the returned session to `stop` so a
  /// stale stop cannot end a newer query.
  func start(_ query: LogQuery, cli: StimCLI, cwd: String) -> Int {
    session += 1
    records = []
    count = 0
    phase = .following
    pinnedToLatest = true
    onChange?(.reset)
    follower.start(query, cli: cli, cwd: cwd)
    return session
  }

  func stop(session: Int) {
    guard session == self.session else { return }
    follower.stop()
    phase = .idle
  }

  func jumpToLatest() {
    pinnedToLatest = true
    onChange?(.jumpToLatest)
  }

  private func handle(_ event: LogFollower.Event) {
    switch event {
    case .records(let batch):
      records.append(contentsOf: batch)
      if records.count > Self.limit {
        let removed = records.count - Self.limit + Self.limit / 10
        records.removeFirst(removed)
        count = records.count
        onChange?(.trimmed(removed))
      } else {
        count = records.count
        onChange?(.appended)
      }
    case .exited(let status, let stderr):
      let detail = stderr.suffix(3).joined(separator: "\n")
      phase = .ended(detail.isEmpty ? "stim logs exited with status \(status)." : detail)
    case .failed(let message):
      phase = .ended(message)
    }
  }
}
