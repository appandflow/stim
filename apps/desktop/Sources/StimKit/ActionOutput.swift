import Foundation

/// What an action sheet keeps of a command's output: at least the last `retainedLines` lines (up to twice
/// that many), the progress rows parsed as lines arrive, and, for a `--json` command, its whole stdout
/// payload, which is kept apart from `lines`.
public struct ActionOutput: Sendable {
  /// The number of most recent lines always kept. Older lines are dropped and counted in `droppedCount`.
  public static let retainedLines = 2000

  public private(set) var lines: [OutputLine] = []
  public private(set) var droppedCount = 0
  public private(set) var steps: [ProgressStep] = []
  public private(set) var stdout = Data()
  private var progress = ActivityProgress.Accumulator()
  private let keepsStdout: Bool
  private var hasStdout = false

  /// With `keepsStdout`, stdout lines go to `stdout` only and never to `lines`.
  public init(keepsStdout: Bool) {
    self.keepsStdout = keepsStdout
  }

  public mutating func append(_ batch: [OutputLine]) {
    var kept: [OutputLine] = []
    for line in batch {
      progress.append(line.text)
      if keepsStdout, line.channel == .stdout {
        if hasStdout { stdout.append(0x0A) }
        stdout.append(contentsOf: line.text.utf8)
        hasStdout = true
      } else {
        kept.append(line)
      }
    }
    steps = progress.steps
    lines.append(contentsOf: kept)
    if lines.count > 2 * Self.retainedLines {
      let excess = lines.count - Self.retainedLines
      lines.removeFirst(excess)
      droppedCount += excess
    }
  }
}

/// Collects lines reported from background queues and hands them to `deliver` on the main queue in
/// order, at most once per `interval`.
public final class OutputBatcher: @unchecked Sendable {
  private let lock = NSLock()
  private var pending: [OutputLine] = []
  private var flushScheduled = false
  private let interval: TimeInterval
  private let deliver: @MainActor ([OutputLine]) -> Void

  public init(interval: TimeInterval = 0.1, deliver: @escaping @MainActor ([OutputLine]) -> Void) {
    self.interval = interval
    self.deliver = deliver
  }

  public func receive(_ line: OutputLine) {
    let schedule: Bool = lock.withLock {
      pending.append(line)
      defer { flushScheduled = true }
      return !flushScheduled
    }
    if schedule {
      DispatchQueue.main.asyncAfter(deadline: .now() + interval) { [self] in flush() }
    }
  }

  /// Delivers what is pending now. Call it on the main queue.
  public func flush() {
    let batch: [OutputLine] = lock.withLock {
      flushScheduled = false
      defer { pending = [] }
      return pending
    }
    if !batch.isEmpty { MainActor.assumeIsolated { deliver(batch) } }
  }
}
