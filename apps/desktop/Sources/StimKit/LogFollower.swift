import Foundation

/// The filters of a `stim logs` query.
public struct LogQuery: Hashable, Sendable {
  public var sources: Set<LogSource> = Set(LogSource.allCases)
  public var slot: String?
  public var minimumLevel: LogLevel = .debug
  public var search = ""
  public var errorsOnly = false
  public var tail = 5000
  public var buildRun: BuildRun?

  /// The retained output of one build, selected by its status timestamps and platform.
  public struct BuildRun: Hashable, Sendable {
    public var platform: String
    public var slot: String
    public var startedAt: Date
    public var finishedAt: Date?
    public var supersededAt: Date?

    public init?(platform: String, slot: String = "default", startedAt: String, finishedAt: String? = nil) {
      guard let start = parseTimestamp(startedAt) else { return nil }
      self.platform = platform
      self.slot = slot
      self.startedAt = start
      self.finishedAt = finishedAt.flatMap(parseTimestamp)
    }

    /// Uses recorded completion or the next run's actual start. Stim status leaves interrupted runs without a finish;
    /// when no later start is recorded, their time scope remains open.
    public func bounded(history: [BuildHistoryEntry], active: Build?) -> Self {
      var run = self
      let own = history.filter { $0.slot == slot && $0.build.platform == platform }
      if run.finishedAt == nil {
        run.finishedAt = own.first { parseTimestamp($0.build.startedAt) == startedAt }?.build.finishedAt.flatMap(
          parseTimestamp)
      }
      if run.finishedAt == nil {
        var starts = own.compactMap { parseTimestamp($0.build.startedAt) }
        if let active, active.platform == platform, active.slot == slot, let start = active.startedDate {
          starts.append(start)
        }
        run.supersededAt = starts.filter { $0 > startedAt }.min()
      }
      return run
    }
  }

  /// Selects one build's full retained output, including records preceding the usual tail.
  public static func build(platform: String, slot: String, startedAt: String, finishedAt: String? = nil) -> LogQuery? {
    guard let run = BuildRun(platform: platform, slot: slot, startedAt: startedAt, finishedAt: finishedAt) else { return nil }
    var query = LogQuery()
    query.sources = [.build]
    query.slot = slot
    query.buildRun = run
    return query
  }

  /// Keeps legacy records without slot/platform tags visible; their concurrent runs can overlap.
  public func includes(_ record: LogRecord) -> Bool {
    guard let buildRun else { return true }
    return record.date >= buildRun.startedAt
      && (buildRun.finishedAt.map { record.date <= $0 } ?? true)
      && (buildRun.supersededAt.map { record.date < $0 } ?? true)
      && (slot == nil || record.slot == nil || record.slot == slot)
      && (record.source != .build || record.platform == nil || record.platform == buildRun.platform)
  }

  public init() {}

  /// `stim logs --json --follow` arguments for this query. With every source
  /// selected no `--source` is passed, so `--errors` keeps the CLI's default
  /// error scope, which leaves general device logs out.
  public var arguments: [String] {
    var args = ["logs", "--json", "--follow"]
    if buildRun == nil { args += ["--tail", String(tail)] }
    if sources.count < LogSource.allCases.count {
      args += ["--source"] + LogSource.allCases.filter(sources.contains).map(\.rawValue)
    }
    if buildRun == nil, let slot { args += ["--slot", slot] }
    if minimumLevel != .debug { args += ["--level", minimumLevel.rawValue] }
    if !search.isEmpty { args += ["--grep", search] }
    if errorsOnly { args.append("--errors") }
    return args
  }
}

/// Runs `stim logs --json --follow` for one query at a time. Starting a new
/// query terminates the previous process, and nothing it still reports is
/// delivered. Records arrive on the main queue in batches. `stopAll` stops
/// every follower, for the app to call as it quits.
public final class LogFollower: @unchecked Sendable {
  public enum Event: Sendable {
    case records([LogRecord])
    /// The process exited with this status and its last lines of stderr.
    case exited(Int32, stderr: [String])
    case failed(String)
  }

  static let batchInterval: TimeInterval = 0.1
  private static let registryLock = NSLock()
  nonisolated(unsafe) private static let followers = NSHashTable<LogFollower>.weakObjects()

  private let lock = NSLock()
  private var process: Process?
  private var generation = 0
  private var pending: [LogRecord] = []
  private var stderr: [String] = []
  private var flushScheduled = false
  private let onEvent: @MainActor (Event) -> Void

  public init(onEvent: @escaping @MainActor (Event) -> Void) {
    self.onEvent = onEvent
    Self.registryLock.withLock { Self.followers.add(self) }
  }

  public static func stopAll() {
    for follower in registryLock.withLock({ followers.allObjects }) { follower.stop() }
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
        onLine: { [weak self] line in self?.receive(line, query: query, generation: generation) },
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

  private func receive(_ line: OutputLine, query: LogQuery, generation: Int) {
    let record = line.channel == .stdout ? LogRecord.parse(line.text) : nil
    let schedule: Bool = lock.withLock {
      guard self.generation == generation else { return false }
      if let record {
        if query.includes(record) { pending.append(record) }
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
