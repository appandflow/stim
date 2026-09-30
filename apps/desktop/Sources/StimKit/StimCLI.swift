import Foundation

/// Reads Stim state through the CLI's JSON output and runs its commands. Stim
/// Desktop never reads or writes `$STIM_HOME` itself, so Stim's locking and
/// ownership rules stay in the CLI. Cancelling the task awaiting a one-shot
/// command terminates its `stim` process and throws `CancellationError`.
public struct StimCLI: Sendable {
  public enum Failure: LocalizedError {
    case notFound
    case toolNotFound(String)
    /// The exit status and the last lines the process wrote to stderr, empty when it wrote none.
    case exited(Int32, stderr: String = "")

    public var errorDescription: String? {
      switch self {
      case .notFound:
        return "Could not find the stim executable. Install it globally, set STIM_BIN, or choose it in Settings."
      case .toolNotFound(let name):
        return "Could not find \(name) on the login shell's PATH. Install Node.js 22.12 or later from nodejs.org, then try again."
      case .exited(let code, let stderr):
        return stderr.isEmpty ? "stim exited with status \(code)." : "stim exited with status \(code): \(stderr)"
      }
    }
  }

  /// The override, `STIM_BIN`, or the first `stim` on the environment's `PATH`.
  public let executable: String?
  /// The environment every `stim` process runs with.
  public let environment: [String: String]

  public init(environment: [String: String], override: String? = nil) {
    var environment = environment
    self.executable = resolveExecutable(
      "stim", override: override.flatMap { $0.isEmpty ? nil : $0 } ?? environment["STIM_BIN"],
      environment: &environment)
    self.environment = environment
  }

  public static let minimumVersion = SemanticVersion("1.11.0")!

  /// What `stim --version` printed, or nil when stim is missing, fails to start, or exits non-zero.
  public func versionOutput() async -> String? {
    (try? await run(["--version"])).map { String(decoding: $0, as: UTF8.self) }
  }

  public func status() async throws -> StatusPayload {
    try JSONDecoder().decode(StatusPayload.self, from: await run(["status", "--json"]))
  }

  public func stats(workspace: String) async throws -> ProjectStats {
    try JSONDecoder().decode(ProjectStats.self, from: await run(["stats", "--json"], cwd: workspace))
  }

  /// `stim <platform> --plan --json` in `workspace`: what the next build would find. It builds nothing.
  public func plan(platform: String, workspace: String) async throws -> BuildPlanOutcome {
    let (status, data, stderr) = try await execute([platform, "--plan", "--json"], cwd: workspace)
    if status == 0 { return .plan(try JSONDecoder().decode(BuildPlan.self, from: data)) }
    guard let refusal = try? JSONDecoder().decode(CommandRefusal.self, from: data) else {
      throw Failure.exited(status, stderr: stderr)
    }
    return .refused(refusal)
  }

  /// `stim gc --json` without `--delete` only reports.
  public func gcReport() async throws -> GcReport {
    try JSONDecoder().decode(GcReport.self, from: await run(["gc", "--json"]))
  }

  /// `stim doctor --json` in `cwd`, which reports and never repairs without `--fix`.
  public func doctor(cwd: String) async throws -> DoctorReport {
    try JSONDecoder().decode(DoctorReport.self, from: await run(["doctor", "--json"], cwd: cwd))
  }

  /// The `offload.machines` states from `stim doctor --json --platform ios` in `cwd`. With `ask`, `--fix` also asks
  /// each named machine this Mac has no pairing with for build access, and again one that revoked it; the iOS
  /// platform keeps `--fix` from cleaning Android build state in that checkout.
  public func buildMachines(cwd: String, ask: Bool) async throws -> [BuildMachineStatus]? {
    let args = ["doctor", "--json", "--platform", "ios"] + (ask ? ["--fix"] : [])
    return try JSONDecoder().decode(DoctorReport.self, from: await run(args, cwd: cwd)).buildMachines
  }

  /// `stim settings --json` in `cwd`: every setting with its origin and layers.
  public func settings(cwd: String) async throws -> SettingsPayload {
    try JSONDecoder().decode(SettingsPayload.self, from: await run(["settings", "--json"], cwd: cwd))
  }

  /// `stim settings set` or, with a nil value, `stim settings unset`, in `cwd`.
  /// A refusal is returned rather than thrown, with the CLI's code and message.
  public func writeSetting(_ key: String, value: String?, scope: SettingScope, cwd: String) async throws
    -> SettingsWriteResult
  {
    let args =
      value.map { ["settings", "set", key, $0] } ?? ["settings", "unset", key]
    let (status, data, stderr) = try await execute(args + ["--scope", scope.rawValue, "--json"], cwd: cwd)
    if status == 0 { return .written(try JSONDecoder().decode(SettingsWritePayload.self, from: data).setting) }
    guard let refusal = try? JSONDecoder().decode(SettingsRefusal.self, from: data) else {
      throw Failure.exited(status, stderr: stderr)
    }
    return .refused(refusal)
  }

  func run(_ args: [String], cwd: String? = nil) async throws -> Data {
    let (status, data, stderr) = try await execute(args, cwd: cwd)
    guard status == 0 else { throw Failure.exited(status, stderr: stderr) }
    return data
  }

  private func execute(_ args: [String], cwd: String?) async throws -> (Int32, Data, String) {
    guard let executable else { throw Failure.notFound }
    let (status, data, stderr) = try await runCommand(executable, args, cwd: cwd, environment: environment)
    return (status, data, stderrTail(stderr))
  }

  /// Runs `stim <args>` in `cwd`, reporting output lines as they arrive and
  /// then the exit status.
  @discardableResult
  public func stream(
    _ args: [String],
    cwd: String,
    onLine: @escaping @Sendable (OutputLine) -> Void,
    onExit: @escaping @Sendable (Int32) -> Void
  ) throws -> Process {
    try stream(StimCommand(args, cwd: cwd), onLine: onLine, onExit: onExit)
  }

  /// Runs `command` in its directory, reporting output lines as they arrive and then the exit status.
  /// A program other than `stim` is looked up on this environment's `PATH`, which starts with the
  /// directory of the resolved `stim`, so `npm` is the one that installed it.
  @discardableResult
  public func stream(
    _ command: StimCommand,
    onLine: @escaping @Sendable (OutputLine) -> Void,
    onExit: @escaping @Sendable (Int32) -> Void
  ) throws -> Process {
    var environment = environment
    let executable: String
    if command.program == "stim" {
      guard let stim = self.executable else { throw Failure.notFound }
      executable = stim
    } else {
      guard let tool = resolveExecutable(command.program, override: nil, environment: &environment) else {
        throw Failure.toolNotFound(command.program)
      }
      executable = tool
    }
    return try ProcessStream.start(
      executable: executable, arguments: command.arguments, cwd: command.cwd, environment: environment,
      onLine: onLine, onExit: onExit)
  }
}

func lastBytes(of url: URL, count: UInt64) throws -> Data {
  let handle = try FileHandle(forReadingFrom: url)
  defer { try? handle.close() }
  let end = try handle.seekToEnd()
  try handle.seek(toOffset: end > count ? end - count : 0)
  return try handle.readToEnd() ?? Data()
}

/// The last three non-empty lines of `text`.
func stderrTail(_ text: String) -> String {
  text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    .suffix(3).joined(separator: "\n")
}

/// Runs `executable` to its exit on a dispatch queue, so the wait parks no thread of Swift's cooperative pool.
/// Returns the exit status, stdout, and the last 4 KB of stderr, which goes to a temporary file so a process that
/// fills stderr cannot block on a pipe nobody reads. Cancelling the calling task terminates the process and throws
/// `CancellationError`, also when the process exits normally after the cancel.
func runCommand(_ executable: String, _ arguments: [String], cwd: String?, environment: [String: String])
  async throws -> (Int32, Data, String)
{
  let run = CancellableRun()
  let result = try await withTaskCancellationHandler {
    try await withCheckedThrowingContinuation { continuation in
      DispatchQueue.global(qos: .default).async {
        continuation.resume(
          with: Result {
            try runToExit(executable, arguments, cwd: cwd, environment: environment, started: run.started)
          })
      }
    }
  } onCancel: {
    run.cancel()
  }
  try Task.checkCancellation()
  return result
}

private func runToExit(
  _ executable: String, _ arguments: [String], cwd: String?, environment: [String: String],
  started: (Process) throws -> Void
) throws -> (Int32, Data, String) {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: executable)
  process.arguments = arguments
  if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
  process.environment = environment
  let out = Pipe()
  process.standardOutput = out
  let errURL = FileManager.default.temporaryDirectory.appendingPathComponent("stim-stderr-\(UUID().uuidString)")
  guard FileManager.default.createFile(atPath: errURL.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
  defer { try? FileManager.default.removeItem(at: errURL) }
  let err = try FileHandle(forWritingTo: errURL)
  defer { try? err.close() }
  process.standardError = err
  try started(process)
  let data = out.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  let stderr = (try? lastBytes(of: errURL, count: 4096)).map { String(decoding: $0, as: UTF8.self) } ?? ""
  return (process.terminationStatus, data, stderr)
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
      process?.terminate()
    }
  }
}

/// The override, or the first `name` on the environment's `PATH`.
func resolveExecutable(_ name: String, override: String?, environment: inout [String: String]) -> String? {
  let executable =
    override.flatMap { $0.isEmpty ? nil : $0 }
    ?? (environment["PATH"] ?? "").split(separator: ":").lazy
    .map { "\($0)/\(name)" }
    .first { FileManager.default.isExecutableFile(atPath: $0) }
  if let executable {
    // stim and stim-server are node scripts whose shebang resolves `node` from PATH; with an
    // override, node can sit next to the script outside PATH, as nvm installs it.
    let binDir = (executable as NSString).deletingLastPathComponent
    environment["PATH"] = "\(binDir):\(environment["PATH"] ?? "/usr/bin:/bin")"
  }
  return executable
}
