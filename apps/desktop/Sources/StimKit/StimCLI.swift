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
    /// The command ran past the seconds it was given and was stopped.
    case timedOut(seconds: Int)

    public var errorDescription: String? {
      switch self {
      case .notFound:
        return "Could not find the stim executable. Install it globally, set STIM_BIN, or choose it in Settings."
      case .toolNotFound(let name):
        return "Could not find \(name) on the login shell's PATH. Install Node.js 22.12 or later from nodejs.org, then try again."
      case .exited(let code, let stderr):
        return stderr.isEmpty ? "stim exited with status \(code)." : "stim exited with status \(code): \(stderr)"
      case .timedOut(let seconds):
        return "stim did not answer within \(seconds) seconds."
      }
    }
  }

  /// The override, `STIM_BIN`, or the first `stim` on the environment's `PATH`.
  public let executable: String?
  /// The environment every `stim` process runs with.
  public let environment: [String: String]
  /// Runs `executable`'s script under the home directory's Node; nil runs `executable` through its own shebang.
  public let launcher: NodeLauncher?
  let diagnostics: Diagnostics

  public init(
    environment: [String: String], override: String? = nil, launcher: NodeLauncher? = nil,
    diagnostics: Diagnostics = .shared
  ) {
    var environment = environment
    self.diagnostics = diagnostics
    self.executable = resolveExecutable(
      "stim", override: override.flatMap { $0.isEmpty ? nil : $0 } ?? environment["STIM_BIN"],
      environment: &environment)
    self.environment = environment
    self.launcher = launcher
  }

  /// `init(environment:override:)` with a launcher, so a project's Node pin does not choose the Node `stim` runs on.
  /// `layout` names the package managers' global directories, which only a version-manager shim needs.
  public static func resolve(
    environment: [String: String], override: String? = nil,
    layout: (() async -> PackageManagerLayout)? = nil
  ) async -> StimCLI {
    let cli = StimCLI(environment: environment, override: override)
    let launcher = await NodeLauncher.resolve(
      executable: cli.executable, name: "stim", environment: cli.environment, layout: layout)
    return StimCLI(environment: environment, override: override, launcher: launcher)
  }

  private func command(_ arguments: [String]) throws -> (program: String, arguments: [String]) {
    guard let executable else { throw Failure.notFound }
    return try launcher?.command(arguments) ?? (executable, arguments)
  }

  /// The directory `stim` keeps its state in: `STIM_HOME` from `environment`, else `~/.stim`.
  public var stimHome: String {
    StimHome.path(environment: environment)
  }

  public static let minimumVersion = SemanticVersion("1.11.0")!

  /// What `stim --version` printed, or nil when stim is missing, fails to start, or exits non-zero.
  public func versionOutput() async -> String? {
    (try? await run(["--version"])).map { String(decoding: $0, as: UTF8.self) }
  }

  public func tutorialGuide() async throws {
    _ = try await run(["guide", "tutorial"])
  }

  /// The raw `stim doctor --json` output for a diagnostics report, or why it could not run.
  public func doctorJSONText(cwd: String) async -> String {
    do {
      return String(decoding: try await run(["doctor", "--json"], cwd: cwd), as: UTF8.self)
    } catch {
      return "stim doctor failed: \(error.localizedDescription)"
    }
  }

  public func status() async throws -> StatusPayload {
    try decodeReporting(StatusPayload.self, from: await run(["status", "--json"]), source: .cli, diagnostics: diagnostics)
  }

  public func stats(workspace: String) async throws -> ProjectStats {
    try decodeReporting(
      ProjectStats.self, from: await run(["stats", "--json"], cwd: workspace), source: .cli, diagnostics: diagnostics)
  }

  /// `stim stats --json` in the home directory, where it reports this Mac's machine-wide part only.
  public func machineStats() async throws -> MachineStats {
    try decodeReporting(
      MachineStats.self, from: await run(["stats", "--json"], cwd: NSHomeDirectory()), source: .cli, diagnostics: diagnostics)
  }

  /// `stim <platform> --plan --json` in `workspace`: what the next build would find. It builds nothing.
  public func plan(platform: String, workspace: String) async throws -> BuildPlanOutcome {
    let args = [platform, "--plan", "--json"]
    let (status, data, stderr) = try await execute(args, cwd: workspace)
    if status == 0 { return .plan(try decodeReporting(BuildPlan.self, from: data, source: .cli, diagnostics: diagnostics)) }
    guard let refusal = try? JSONDecoder().decode(CommandRefusal.self, from: data) else {
      throw exitFailure(args, status: status, stdout: data, stderr: stderr)
    }
    return .refused(refusal)
  }

  /// `stim gc --json` without `--delete` only reports.
  public func gcReport() async throws -> GcReport {
    try decodeReporting(GcReport.self, from: await run(["gc", "--json"]), source: .cli, diagnostics: diagnostics)
  }

  /// `stim doctor --json` in `cwd`, which reports and never repairs without `--fix`.
  public func doctor(cwd: String) async throws -> DoctorReport {
    try decodeReporting(
      DoctorReport.self, from: await run(["doctor", "--json"], cwd: cwd), source: .cli, diagnostics: diagnostics)
  }

  /// The `remote.machines` states from `stim doctor --json --platform ios` in `cwd`. With `ask`, `--fix` also asks
  /// each named machine this Mac has no pairing with for build access, and again one that revoked it; the iOS
  /// platform keeps `--fix` from cleaning Android build state in that checkout.
  public func buildMachines(cwd: String, ask: Bool) async throws -> [BuildMachineStatus]? {
    try await machineAccess(cwd: cwd, ask: ask).remoteMachines
  }

  /// Both build and device-host access states. Extra environment applies only to this doctor process.
  public func machineAccess(
    cwd: String, ask: Bool, extraEnvironment: [String: String] = [:], timeout: TimeInterval? = nil
  ) async throws -> DoctorReport {
    let args = ["doctor", "--json", "--platform", "ios"] + (ask ? ["--fix"] : [])
    return try decodeReporting(
      DoctorReport.self,
      from: await run(args, cwd: cwd, extraEnvironment: extraEnvironment, timeout: timeout ?? (ask ? 120 : 30)),
      source: .cli, diagnostics: diagnostics
    )
  }

  /// `stim settings --json` in `cwd`: every setting with its origin and layers.
  public func settings(cwd: String) async throws -> SettingsPayload {
    try decodeReporting(
      SettingsPayload.self, from: await run(["settings", "--json"], cwd: cwd), source: .cli, diagnostics: diagnostics)
  }

  /// `stim settings set` or, with a nil value, `stim settings unset`, in `cwd`.
  /// A refusal is returned rather than thrown, with the CLI's code and message.
  public func writeSetting(_ key: String, value: String?, scope: SettingScope, cwd: String) async throws
    -> SettingsWriteResult
  {
    let args =
      value.map { ["settings", "set", key, $0] } ?? ["settings", "unset", key]
    let fullArgs = args + ["--scope", scope.rawValue, "--json"]
    let (status, data, stderr) = try await execute(fullArgs, cwd: cwd)
    if status == 0 {
      return .written(
        try decodeReporting(SettingsWritePayload.self, from: data, source: .cli, diagnostics: diagnostics).setting)
    }
    guard let refusal = try? JSONDecoder().decode(SettingsRefusal.self, from: data) else {
      throw exitFailure(fullArgs, status: status, stdout: data, stderr: stderr)
    }
    return .refused(refusal)
  }

  func run(
    _ args: [String], cwd: String? = nil, extraEnvironment: [String: String] = [:], timeout: TimeInterval? = nil
  ) async throws -> Data {
    let (status, data, stderr) = try await execute(
      args, cwd: cwd, extraEnvironment: extraEnvironment, timeout: timeout)
    guard status == 0 else { throw exitFailure(args, status: status, stdout: data, stderr: stderr) }
    return data
  }

  private func exitFailure(_ args: [String], status: Int32, stdout: Data, stderr: String) -> Failure {
    let code = Diagnostics.stimCode(in: [stderr, String(decoding: stdout.prefix(8192), as: UTF8.self)])
    diagnostics.report(.cli(command: Diagnostics.commandName(args), outcome: .exited(status), stimCode: code))
    return .exited(status, stderr: stderr)
  }

  private func execute(
    _ args: [String], cwd: String?, extraEnvironment: [String: String] = [:], timeout: TimeInterval? = nil
  ) async throws -> (
    Int32, Data, String
  ) {
    let name = Diagnostics.commandName(args)
    let command: (program: String, arguments: [String])
    do {
      command = try self.command(args)
    } catch Failure.notFound {
      diagnostics.report(.cli(command: name, outcome: .notFound, stimCode: nil))
      throw Failure.notFound
    }
    diagnostics.tag("last_cli_command", name)
    diagnostics.breadcrumb("cli", "start \(name)")
    let startedAt = Date()
    let log = DebugLog.CLIRun(tool: "stim", arguments: args, cwd: cwd)
    var environment = environment.merging(extraEnvironment) { _, extra in extra }
    environment["STIM_RUN_ID"] = log.runID
    var request = ProcessRequest(
      command.program, command.arguments, cwd: cwd, environment: environment, timeout: timeout)
    request.captureStderr = true
    let result: ProcessResult
    do {
      result = try await request.run()
    } catch {
      log.fail(error)
      throw error
    }
    log.finish(
      status: result.status, timedOut: result.timedOut, stderr: stderrTail(result.stderrText),
      stdout: result.status == 0 ? "" : result.stdoutText)
    diagnostics.breadcrumb(
      "cli", "finish \(name)",
      data: [
        "duration_ms": String(Int(Date().timeIntervalSince(startedAt) * 1000)),
        "exit_code": result.timedOut ? "timed-out" : String(result.status),
      ])
    if result.timedOut, let timeout {
      diagnostics.report(.cli(command: name, outcome: .timedOut, stimCode: nil))
      throw Failure.timedOut(seconds: Int(timeout))
    }
    return (result.status, result.stdout, stderrTail(result.stderrText))
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
    environment["NO_COLOR"] = "1"
    environment["FORCE_COLOR"] = "0"
    let launch: (program: String, arguments: [String])
    if command.program == "stim" {
      launch = try self.command(command.arguments)
    } else {
      guard let tool = resolveExecutable(command.program, override: nil, environment: &environment) else {
        throw Failure.toolNotFound(command.program)
      }
      launch = (tool, command.arguments)
    }
    let log = DebugLog.CLIRun(tool: command.program, arguments: command.arguments, cwd: command.cwd)
    environment["STIM_RUN_ID"] = log.runID
    let tail = LockedValue([String]())
    let onLine: @Sendable (OutputLine) -> Void = { line in
      if line.channel == .stderr { tail.withLock { $0 = Array(($0 + [line.text]).suffix(3)) } }
      onLine(line)
    }
    let onExit: @Sendable (Int32) -> Void = { status in
      log.finish(status: status, stderr: tail.withLock { $0.joined(separator: "\n") })
      onExit(status)
    }
    guard command.program == "stim" else {
      return try ProcessStream.start(
        executable: launch.program, arguments: launch.arguments, cwd: command.cwd, environment: environment,
        onLine: onLine, onExit: onExit)
    }
    let name = Diagnostics.commandName(command.arguments)
    let diagnostics = diagnostics
    let startedAt = Date()
    diagnostics.tag("last_cli_command", name)
    diagnostics.breadcrumb("cli", "start \(name)")
    return try ProcessStream.start(
      executable: launch.program, arguments: launch.arguments, cwd: command.cwd, environment: environment,
      onLine: onLine,
      onExit: { status in
        diagnostics.breadcrumb(
          "cli", "finish \(name)",
          data: ["duration_ms": String(Int(Date().timeIntervalSince(startedAt) * 1000)), "exit_code": String(status)])
        onExit(status)
      })
  }
}

/// The last three non-empty lines of `text`.
func stderrTail(_ text: String) -> String {
  text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    .suffix(3).joined(separator: "\n")
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
