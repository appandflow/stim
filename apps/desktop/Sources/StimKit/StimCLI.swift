import Foundation

/// Reads Stim state through the CLI's JSON output and runs its commands. Stim
/// Desktop never reads or writes `$STIM_HOME` itself, so Stim's locking and
/// ownership rules stay in the CLI.
public struct StimCLI: Sendable {
  public enum Failure: LocalizedError {
    case notFound
    case exited(Int32)

    public var errorDescription: String? {
      switch self {
      case .notFound:
        return "Could not find the stim executable. Install it globally, set STIM_BIN, or choose it in Settings."
      case .exited(let code): return "stim exited with status \(code)."
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

  public func status() throws -> StatusPayload {
    try JSONDecoder().decode(StatusPayload.self, from: run(["status", "--json"]))
  }

  public func stats(workspace: String) throws -> ProjectStats {
    try JSONDecoder().decode(ProjectStats.self, from: run(["stats", "--json"], cwd: workspace))
  }

  /// `stim gc --json` without `--delete` only reports.
  public func gcReport() throws -> GcReport {
    try JSONDecoder().decode(GcReport.self, from: run(["gc", "--json"]))
  }

  /// `stim settings --json` in `cwd`: every setting with its origin and layers.
  public func settings(cwd: String) throws -> SettingsPayload {
    try JSONDecoder().decode(SettingsPayload.self, from: run(["settings", "--json"], cwd: cwd))
  }

  /// `stim settings set` or, with a nil value, `stim settings unset`, in `cwd`.
  /// A refusal is returned rather than thrown, with the CLI's code and message.
  public func writeSetting(_ key: String, value: String?, scope: SettingScope, cwd: String) throws
    -> SettingsWriteResult
  {
    let args =
      value.map { ["settings", "set", key, $0] } ?? ["settings", "unset", key]
    let (status, data) = try execute(args + ["--scope", scope.rawValue, "--json"], cwd: cwd)
    if status == 0 { return .written(try JSONDecoder().decode(SettingsWritePayload.self, from: data).setting) }
    guard let refusal = try? JSONDecoder().decode(SettingsRefusal.self, from: data) else {
      throw Failure.exited(status)
    }
    return .refused(refusal)
  }

  func run(_ args: [String], cwd: String? = nil) throws -> Data {
    let (status, data) = try execute(args, cwd: cwd)
    guard status == 0 else { throw Failure.exited(status) }
    return data
  }

  private func execute(_ args: [String], cwd: String?) throws -> (Int32, Data) {
    guard let executable else { throw Failure.notFound }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = args
    if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    process.environment = environment
    let out = Pipe()
    process.standardOutput = out
    process.standardError = FileHandle.nullDevice
    try process.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, data)
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
    guard let executable else { throw Failure.notFound }
    return try ProcessStream.start(
      executable: executable, arguments: args, cwd: cwd, environment: environment,
      onLine: onLine, onExit: onExit)
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
