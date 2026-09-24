import Foundation

/// Reads Stim state through the CLI's JSON output and runs its commands. Stim
/// Desktop never reads or writes `$STIM_HOME` itself, so Stim's locking and
/// ownership rules stay in the CLI.
public enum StimCLI {
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

  public static let executable: String? = resolveExecutable()

  public static func status() throws -> StatusPayload {
    try JSONDecoder().decode(StatusPayload.self, from: run(["status", "--json"]))
  }

  public static func stats(workspace: String) throws -> ProjectStats {
    try JSONDecoder().decode(ProjectStats.self, from: run(["stats", "--json"], cwd: workspace))
  }

  /// `stim gc --json` without `--delete` only reports.
  public static func gcReport() throws -> GcReport {
    try JSONDecoder().decode(GcReport.self, from: run(["gc", "--json"]))
  }

  static func run(_ args: [String], cwd: String? = nil) throws -> Data {
    guard let executable else { throw Failure.notFound }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = args
    if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    process.environment = environment(for: executable)
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
  public static func stream(
    _ args: [String],
    cwd: String,
    onLine: @escaping @Sendable (OutputLine) -> Void,
    onExit: @escaping @Sendable (Int32) -> Void
  ) throws -> Process {
    guard let executable else { throw Failure.notFound }
    return try ProcessStream.start(
      executable: executable, arguments: args, cwd: cwd, environment: environment(for: executable),
      onLine: onLine, onExit: onExit)
  }

  private static func environment(for executable: String) -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    // stim is a node script; its shebang resolves `node` from PATH, which a
    // Finder-launched app does not have when node comes from nvm.
    let binDir = (executable as NSString).deletingLastPathComponent
    env["PATH"] = "\(binDir):\(env["PATH"] ?? "/usr/bin:/bin")"
    return env
  }

  private static func resolveExecutable() -> String? {
    if let explicit = ProcessInfo.processInfo.environment["STIM_BIN"] { return explicit }
    // A Finder-launched app gets launchd's PATH, not the login shell's, so ask the shell.
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = ["-lic", "command -v stim"]
    let out = Pipe()
    process.standardOutput = out
    process.standardError = FileHandle.nullDevice
    guard (try? process.run()) != nil else { return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let path = String(decoding: data, as: UTF8.self)
      .split(separator: "\n").last?.trimmingCharacters(in: .whitespaces)
    return path?.hasPrefix("/") == true ? path : nil
  }
}
