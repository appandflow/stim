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
      case .notFound: return "Could not find the stim executable. Install it globally or set STIM_BIN."
      case .exited(let code): return "stim exited with status \(code)."
      }
    }
  }

  /// `STIM_BIN`, or the first `stim` on the environment's `PATH`.
  public let executable: String?
  /// The environment every `stim` process runs with.
  public let environment: [String: String]

  public init(environment: [String: String]) {
    var environment = environment
    let executable =
      environment["STIM_BIN"]
      ?? (environment["PATH"] ?? "").split(separator: ":").lazy
      .map { "\($0)/stim" }
      .first { FileManager.default.isExecutableFile(atPath: $0) }
    if let executable {
      // stim is a node script whose shebang resolves `node` from PATH; with
      // STIM_BIN set, node can sit next to it outside PATH, as nvm installs it.
      let binDir = (executable as NSString).deletingLastPathComponent
      environment["PATH"] = "\(binDir):\(environment["PATH"] ?? "/usr/bin:/bin")"
    }
    self.executable = executable
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

  func run(_ args: [String], cwd: String? = nil) throws -> Data {
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
    guard process.terminationStatus == 0 else { throw Failure.exited(process.terminationStatus) }
    return data
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
