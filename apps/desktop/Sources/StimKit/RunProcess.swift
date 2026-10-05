import Foundation

/// What a finished `ProcessRequest` reports.
public struct ProcessResult: Sendable {
  /// The exit status, or the terminating signal after an uncaught one; -1 when a process that was sent SIGKILL
  /// had still not exited.
  public var status: Int32
  /// Whether the process ended by exiting rather than by an uncaught signal.
  public var exited: Bool
  /// Whether the process ran past its timeout and was signalled. Its output up to then is still returned.
  public var timedOut: Bool
  public var stdout: Data
  /// The last `ProcessRequest.stderrLimit` bytes of stderr; empty unless `captureStderr` is set.
  public var stderr: Data

  public var succeeded: Bool { exited && !timedOut && status == 0 }
  public var stdoutText: String { String(decoding: stdout, as: UTF8.self) }
  public var stderrText: String { String(decoding: stderr, as: UTF8.self) }
}

/// The processes of a set of runs, so the app can terminate what is still running when it quits.
public final class ProcessRegistry: @unchecked Sendable {
  private let lock = NSLock()
  private var processes: Set<Process> = []

  public init() {}

  func insert(_ process: Process) { lock.withLock { _ = processes.insert(process) } }
  func remove(_ process: Process) { lock.withLock { _ = processes.remove(process) } }

  public func terminateAll() {
    lock.withLock {
      for process in processes where process.isRunning { process.terminate() }
    }
  }
}

/// One run of an executable with an argument list, never through a shell, to its exit. Stdin is `/dev/null` unless `input` supplies bytes.
/// Stdout, and stderr when asked for, go to temporary files, so a process that fills either cannot block on a
/// pipe nobody reads, and a background child that inherits them cannot keep the run from ending.
public struct ProcessRequest: Sendable {
  public var executable: String
  public var arguments: [String]
  public var cwd: String?
  /// Bytes read from stdin, without a shell or a pipe that can block the writer.
  public var input: Data?
  /// The child's environment; nil inherits this process's.
  public var environment: [String: String]?
  /// Seconds the process may run before it is signalled; nil waits for it.
  public var timeout: TimeInterval?
  /// The signal sent at the timeout. An interactive zsh ignores SIGTERM, so a login shell needs SIGKILL.
  public var timeoutSignal: Int32 = SIGTERM
  /// Seconds between `timeoutSignal` and SIGKILL.
  public var killGrace: TimeInterval = 5
  public var captureStderr = false
  public var stderrLimit: UInt64 = 4096
  /// The child's quality of service; nil leaves it unset. macOS throttles the disk I/O of utility and
  /// background children.
  public var qualityOfService: QualityOfService?
  public var registry: ProcessRegistry?

  public init(
    _ executable: String, _ arguments: [String] = [], cwd: String? = nil, environment: [String: String]? = nil,
    timeout: TimeInterval? = nil
  ) {
    self.executable = executable
    self.arguments = arguments
    self.cwd = cwd
    self.environment = environment
    self.timeout = timeout
  }

  /// Runs the process on the calling thread and throws when it cannot start.
  public func runBlocking() throws -> ProcessResult {
    try execute(started: { try $0.run() })
  }

  /// Runs the process on a dispatch queue, so the wait parks no thread of Swift's cooperative pool. Cancelling
  /// the calling task terminates the process and throws `CancellationError`, also when the process exits
  /// normally after the cancel.
  public func run() async throws -> ProcessResult {
    let run = CancellableRun()
    let result = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .default).async {
          continuation.resume(with: Result { try execute(started: run.started) })
        }
      }
    } onCancel: {
      run.cancel()
    }
    try Task.checkCancellation()
    return result
  }

  private func execute(started: (Process) throws -> Void) throws -> ProcessResult {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    if let environment { process.environment = environment }
    if let qualityOfService { process.qualityOfService = qualityOfService }
    var inputURL: URL?
    var inputHandle: FileHandle?
    defer {
      try? inputHandle?.close()
      inputURL.map { try? FileManager.default.removeItem(at: $0) }
    }
    if let input {
      let url = try Self.createTemporaryFile("stdin")
      inputURL = url
      try input.write(to: url)
      let handle = try FileHandle(forReadingFrom: url)
      inputHandle = handle
      process.standardInput = handle
    } else {
      process.standardInput = FileHandle.nullDevice
    }
    let outURL = try Self.createTemporaryFile("stdout")
    defer { try? FileManager.default.removeItem(at: outURL) }
    let out = try FileHandle(forWritingTo: outURL)
    defer { try? out.close() }
    process.standardOutput = out
    var errURL: URL?
    var errHandle: FileHandle?
    defer { try? errHandle?.close() }
    if captureStderr {
      let url = try Self.createTemporaryFile("stderr")
      errURL = url
      let err = try FileHandle(forWritingTo: url)
      errHandle = err
      process.standardError = err
    } else {
      process.standardError = FileHandle.nullDevice
    }
    defer { errURL.map { try? FileManager.default.removeItem(at: $0) } }
    let exited = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in exited.signal() }
    try started(process)
    registry?.insert(process)
    defer { registry?.remove(process) }

    var timedOut = false
    if let timeout {
      if exited.wait(timeout: .now() + timeout) == .timedOut {
        timedOut = true
        if process.isRunning { kill(process.processIdentifier, timeoutSignal) }
        if exited.wait(timeout: .now() + killGrace) == .timedOut {
          if process.isRunning { kill(process.processIdentifier, SIGKILL) }
          _ = exited.wait(timeout: .now() + 2)
        }
      }
    } else {
      exited.wait()
    }
    let stdout = (try? Data(contentsOf: outURL)) ?? Data()
    let stderr = errURL.flatMap { try? Self.lastBytes(of: $0, count: stderrLimit) } ?? Data()
    guard !process.isRunning else {
      return ProcessResult(status: -1, exited: false, timedOut: true, stdout: stdout, stderr: stderr)
    }
    return ProcessResult(
      status: process.terminationStatus, exited: process.terminationReason == .exit, timedOut: timedOut,
      stdout: stdout, stderr: stderr)
  }

  private static func createTemporaryFile(_ label: String) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("stim-\(label)-\(UUID().uuidString)")
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
    return url
  }

  private static func lastBytes(of url: URL, count: UInt64) throws -> Data {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let end = try handle.seekToEnd()
    try handle.seek(toOffset: end > count ? end - count : 0)
    return try handle.readToEnd() ?? Data()
  }
}

/// Starts a process unless the run was already cancelled, and terminates it on cancel.
private final class CancellableRun: @unchecked Sendable {
  private let lock = NSLock()
  private var process: Process?
  private var cancelled = false

  func started(_ process: Process) throws {
    try lock.withLock {
      if cancelled { throw CancellationError() }
      try process.run()
      self.process = process
    }
  }

  func cancel() {
    lock.withLock {
      cancelled = true
      if process?.isRunning == true { process?.terminate() }
    }
  }
}
