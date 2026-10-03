import Combine
import Foundation
import StimKit

/// The entries of one running `stim logs --follow` query. Generic queries keep the newest `limit` records;
/// a scoped build keeps its full retained output.
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
    /// Rows from `from` on were replaced; `replaced` are their leads.
    case updated(from: Int, replaced: [Row.Lead])
    /// These rows were removed from the front, together `lines` lines tall.
    case trimmed(rows: Int, lines: Int)
    /// The slot column grew, so rows already drawn pad their slot label to the new width.
    case slotColumnWidened
    case jumpToLatest
    case reveal(Int)
  }

  struct Row {
    struct Lead: Equatable {
      var ts: Double
      var src: String
      var msg: String
    }

    var entry: LogEntry
    var view: LogEntryView
    var preview: StackPreview?

    var lead: Lead { Lead(ts: entry.lead.ts, src: entry.lead.src, msg: entry.lead.msg) }

    var lines: Int {
      1 + (view.location == nil ? 0 : 1) + (preview.map { $0.frames.count + ($0.hidden > 0 ? 1 : 0) } ?? 0)
    }
  }

  private(set) var rows: [Row] = []
  @Published private(set) var count = 0
  @Published private(set) var phase = Phase.idle
  @Published var pinnedToLatest = true
  var slotWidth: Int { list.slotWidth }
  var onChange: ((Change) -> Void)?

  private var list = LogEntryList()
  private var root = ""
  private let home = NSHomeDirectory()
  private var session = 0
  private var following: LogQuery?
  private var pending: (at: Double, query: LogQuery)?
  private lazy var follower = LogFollower { [weak self] event in self?.handle(event) }

  /// Replaces the running query. Pass the returned session to `stop` so a
  /// stale stop cannot end a newer query.
  func start(_ query: LogQuery, cli: StimCLI, cwd: String) -> Int {
    session += 1
    following = query
    if let pending, pending.query != query { self.pending = nil }
    list = LogEntryList()
    rows = []
    root = cwd
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

  /// Scrolls to and selects the first record at or after `at`, epoch ms, once `query` is followed and that record
  /// has arrived.
  func reveal(at: Double, in query: LogQuery) {
    pending = (at, query)
    revealPending()
  }

  private func revealPending() {
    guard let pending, pending.query == following, let record = list.records.firstIndex(where: { $0.ts >= pending.at }),
      let row = list.entryIndex(ofRecord: record)
    else { return }
    self.pending = nil
    pinnedToLatest = false
    onChange?(.reveal(row))
  }

  private func row(_ entry: LogEntry) -> Row {
    Row(
      entry: entry, view: viewEntry(entry, root: root, home: home),
      preview: stackPreview(entry.lead.stack, root: root, home: home))
  }

  private func handle(_ event: LogFollower.Event) {
    switch event {
    case .records(let batch):
      let width = list.slotWidth
      let from = list.append(batch)
      let replaced = rows[from...].map(\.lead)
      rows.removeSubrange(from...)
      rows += list.entries[from...].map(row)
      onChange?(.updated(from: from, replaced: replaced))
      if following?.buildRun == nil, list.records.count > Self.limit {
        let dropped = list.dropOldest(list.records.count - Self.limit + Self.limit / 10)
        let lines = rows[..<dropped].reduce(0) { $0 + $1.lines }
        rows.removeFirst(dropped)
        onChange?(.trimmed(rows: dropped, lines: lines))
      }
      if list.slotWidth != width { onChange?(.slotColumnWidened) }
      count = list.records.count
      revealPending()
    case .exited(let status, let stderr):
      let detail = stderr.suffix(3).joined(separator: "\n")
      phase = .ended(detail.isEmpty ? "stim logs exited with status \(status)." : detail)
    case .failed(let message):
      phase = .ended(message)
    }
  }
}
