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
  /// Runs `executable`'s script under the home directory's Node; nil runs `executable` through its own shebang.
  public let launcher: NodeLauncher?

  public init(environment: [String: String], override: String? = nil, launcher: NodeLauncher? = nil) {
    var environment = environment
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

  public func status() async throws -> StatusPayload {
    try JSONDecoder().decode(StatusPayload.self, from: await run(["status", "--json"]))
  }

  public func stats(workspace: String) async throws -> ProjectStats {
    try JSONDecoder().decode(ProjectStats.self, from: await run(["stats", "--json"], cwd: workspace))
  }

  /// `stim stats --json` in the home directory, where it reports this Mac's machine-wide part only.
  public func machineStats() async throws -> MachineStats {
    try JSONDecoder().decode(MachineStats.self, from: await run(["stats", "--json"], cwd: NSHomeDirectory()))
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
    let command = try command(args)
    var request = ProcessRequest(command.program, command.arguments, cwd: cwd, environment: environment)
    request.captureStderr = true
    let result = try await request.run()
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
    return try ProcessStream.start(
      executable: launch.program, arguments: launch.arguments, cwd: command.cwd, environment: environment,
      onLine: onLine, onExit: onExit)
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
