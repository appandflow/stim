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

  public var subscriptionMethod: String { buildRun == nil ? "logs.subscribe" : "desktop.logs.subscribe" }

  public func params(workspace: String) -> [String: JSONValue] {
    var params: [String: JSONValue] = ["workspace": .string(workspace)]
    if buildRun == nil { params["tail"] = .number(Double(tail)) }
    if sources.count < LogSource.allCases.count {
      params["sources"] = .array(LogSource.allCases.filter(sources.contains).map { .string($0.rawValue) })
    }
    if buildRun == nil, let slot { params["slot"] = .string(slot) }
    if minimumLevel != .debug { params["level"] = .string(minimumLevel.rawValue) }
    if !search.isEmpty { params["grep"] = .string(search) }
    if errorsOnly { params["errors"] = .bool(true) }
    return params
  }
}

/// Follows one local server query at a time; replacing or stopping it ignores obsolete events.
@MainActor public final class LogFollower {
  public enum Event: Sendable {
    case reset
    case records([LogRecord])
    case ended
    case failed(String)
  }

  private static let followers = NSHashTable<LogFollower>.weakObjects()
  @MainActor private final class Cancellation {
    var run: (() -> Void)?
    func stop() {
      run?()
      run = nil
    }
  }

  private let cancellation = Cancellation()
  private var generation = 0
  private var pending: [LogRecord] = []
  private var flushTask: Task<Void, Never>?
  private let onEvent: @MainActor (Event) -> Void

  public init(onEvent: @escaping @MainActor (Event) -> Void) {
    self.onEvent = onEvent
    Self.followers.add(self)
  }

  deinit {
    let cancellation = cancellation
    Task { @MainActor in cancellation.stop() }
    flushTask?.cancel()
  }

  public static func stopAll() {
    for follower in followers.allObjects { follower.stop() }
  }

  public func start(
    _ query: LogQuery, stimHome: String, connection: (client: ServerClient, home: String)?, cwd: String
  ) {
    stop()
    let current = generation
    guard let client = readCapableServer(connection, stimHome: stimHome) else {
      onEvent(.failed("The local stim-server is not ready to read logs for this Stim home."))
      return
    }
    if query.buildRun != nil {
      guard case .open(let hello) = client.state, hello.features?.contains("desktop-full-logs") == true else {
        onEvent(.failed("Update the local stim-server to read complete build logs."))
        return
      }
    }
    cancellation.run = client.subscribe(
      query.subscriptionMethod, params: { query.params(workspace: cwd) },
      onSubscribed: { [weak self] _ in
        guard let self, generation == current else { return }
        flushTask?.cancel()
        flushTask = nil
        pending = []
        onEvent(.reset)
      },
      onEvent: { [weak self] event in
        guard let self, generation == current else { return }
        if let error = event.error {
          flush()
          onEvent(.failed(error.localizedDescription))
        } else if event.name == "logs-ended" {
          flush()
          onEvent(.ended)
        } else if event.name == "logs" {
          guard case .array(let values) = event.fields["records"] else {
            onEvent(.failed("The local stim-server returned an invalid log batch."))
            return
          }
          let encoder = JSONEncoder()
          let decoder = JSONDecoder()
          pending += values.compactMap { value -> LogRecord? in
            guard let data = try? encoder.encode(value), let record = try? decoder.decode(LogRecord.self, from: data),
              query.includes(record)
            else { return nil }
            return record
          }
          if flushTask == nil, !pending.isEmpty {
            flushTask = Task { [weak self] in
              try? await Task.sleep(for: .milliseconds(100))
              if !Task.isCancelled { self?.flush() }
            }
          }
        }
      }, onVideo: { _ in })
  }

  public func stop() {
    generation += 1
    cancellation.stop()
    flushTask?.cancel()
    flushTask = nil
    pending = []
  }

  private func flush() {
    flushTask?.cancel()
    flushTask = nil
    let batch = pending
    pending = []
    if !batch.isEmpty { onEvent(.records(batch)) }
  }
}
