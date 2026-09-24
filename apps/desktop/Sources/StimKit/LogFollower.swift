import Foundation

/// The filters of a `stim logs` query.
public struct LogQuery: Hashable, Sendable {
  public var sources: Set<LogSource> = Set(LogSource.allCases)
  public var slot: String?
  public var minimumLevel: LogLevel = .debug
  public var search = ""
  public var errorsOnly = false
  public var tail = 5000

  public init() {}

  /// `stim logs --json --follow` arguments for this query. With every source
  /// selected no `--source` is passed, so `--errors` keeps the CLI's default
  /// error scope, which leaves general device logs out.
  public var arguments: [String] {
    var args = ["logs", "--json", "--follow", "--tail", String(tail)]
    if sources.count < LogSource.allCases.count {
      args += ["--source"] + LogSource.allCases.filter(sources.contains).map(\.rawValue)
    }
    if let slot { args += ["--slot", slot] }
    if minimumLevel != .debug { args += ["--level", minimumLevel.rawValue] }
    if !search.isEmpty { args += ["--grep", search] }
    if errorsOnly { args.append("--errors") }
    return args
  }
}

/// Runs `stim logs --json --follow` for one query at a time. Starting a new
/// query terminates the previous process, and nothing it still reports is
/// delivered. Records arrive on the main queue in batches.
public final class LogFollower: @unchecked Sendable {
  public enum Event: Sendable {
    case records([LogRecord])
    /// The process exited with this status and its last lines of stderr.
    case exited(Int32, stderr: [String])
    case failed(String)
  }

  static let batchInterval: TimeInterval = 0.1

  private let lock = NSLock()
  private var process: Process?
  private var generation = 0
  private var pending: [LogRecord] = []
  private var stderr: [String] = []
  private var flushScheduled = false
  private let onEvent: @MainActor (Event) -> Void

  public init(onEvent: @escaping @MainActor (Event) -> Void) {
    self.onEvent = onEvent
  }

  deinit {
    process?.terminate()
  }

  public var runningProcess: Process? { lock.withLock { process } }

  public func start(_ query: LogQuery, cli: StimCLI, cwd: String) {
    let generation = lock.withLock {
      process?.terminate()
      process = nil
      pending = []
      stderr = []
      self.generation += 1
      return self.generation
    }
    do {
      let started = try cli.stream(
        query.arguments, cwd: cwd,
        onLine: { [weak self] line in self?.receive(line, generation: generation) },
        onExit: { [weak self] status in self?.exited(status, generation: generation) })
      lock.withLock {
        if self.generation == generation { process = started } else { started.terminate() }
      }
    } catch {
      deliver(.failed(error.localizedDescription), generation: generation)
    }
  }

  public func stop() {
    lock.withLock {
      process?.terminate()
      process = nil
      generation += 1
    }
  }

  private func receive(_ line: OutputLine, generation: Int) {
    let record = line.channel == .stdout ? LogRecord.parse(line.text) : nil
    let schedule: Bool = lock.withLock {
      guard self.generation == generation else { return false }
      if let record {
        pending.append(record)
      } else if line.channel == .stderr, !line.text.isEmpty {
        stderr = Array((stderr + [line.text]).suffix(20))
      }
      guard !flushScheduled, !pending.isEmpty else { return false }
      flushScheduled = true
      return true
    }
    if schedule {
      DispatchQueue.main.asyncAfter(deadline: .now() + Self.batchInterval) { [weak self] in
        self?.flush(generation: generation)
      }
    }
  }

  private func flush(generation: Int) {
    let batch: [LogRecord]? = lock.withLock {
      flushScheduled = false
      guard self.generation == generation else { return nil }
      defer { pending = [] }
      return pending
    }
    if let batch, !batch.isEmpty { MainActor.assumeIsolated { onEvent(.records(batch)) } }
  }

  private func exited(_ status: Int32, generation: Int) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.flush(generation: generation)
      let lines: [String]? = self.lock.withLock {
        guard self.generation == generation else { return nil }
        self.process = nil
        return self.stderr
      }
      if let lines { MainActor.assumeIsolated { self.onEvent(.exited(status, stderr: lines)) } }
    }
  }

  private func deliver(_ event: Event, generation: Int) {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.lock.withLock({ self.generation == generation }) else { return }
      MainActor.assumeIsolated { self.onEvent(event) }
    }
  }
}
