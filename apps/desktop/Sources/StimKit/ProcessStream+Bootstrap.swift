import Foundation

extension ProcessStream {
  /// Runs an external bootstrap tool on `environment`'s PATH with streamed output and a debug-log receipt.
  /// Stim commands must use the local server instead.
  @discardableResult
  public static func start(
    _ command: StimCommand, environment: [String: String],
    onLine: @escaping @Sendable (OutputLine) -> Void, onExit: @escaping @Sendable (Int32) -> Void
  ) throws -> Process {
    guard command.program != "stim" else {
      throw ServerError(code: "unsupported", message: "Unsupported Desktop command.")
    }
    guard let executable = SetupChecks.tool(command.program, environment: environment) else {
      throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: command.program])
    }
    var environment = environment
    environment["NO_COLOR"] = "1"
    environment["FORCE_COLOR"] = "0"
    let log = DebugLog.CLIRun(tool: command.program, arguments: command.arguments, cwd: command.cwd)
    environment["STIM_RUN_ID"] = log.runID
    let tail = LockedValue([String]())
    do {
      return try start(
        executable: executable, arguments: command.arguments, cwd: command.cwd, environment: environment,
        onLine: { line in
          if line.channel == .stderr { tail.withLock { $0 = Array(($0 + [line.text]).suffix(3)) } }
          onLine(line)
        },
        onExit: { status in
          log.finish(status: status, stderr: tail.withLock { $0.joined(separator: "\n") })
          onExit(status)
        })
    } catch {
      log.fail(error)
      throw error
    }
  }
}
