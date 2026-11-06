import Foundation

/// The GC JSON report or refusal, exit status and human summary from the private server.
public struct ServerGcResult: Sendable {
  public let exitStatus: Int32
  public let stdout: Data
  public let message: String
}

/// Runs GC through the same-home bundled server. Cancellation awaits cleanup acknowledgement;
/// reconnect never repeats a mutation whose dispatch may already have happened.
@MainActor public func runServerGc(
  _ command: StimCommand, stimHome: String, connection: (client: ServerClient, home: String)?,
  onLine: @escaping @MainActor (OutputLine) -> Void = { _ in }
) async throws -> ServerGcResult {
  try Task.checkCancellation()
  let client = try desktopActionServer(connection, stimHome: stimHome, action: "clean up this Stim home")
  guard case .open(let hello) = client.state, hello.desktopApi == ServerProtocol.desktopApi else {
    throw ServerError(code: "unsupported", message: "Update stim-server to run cleanup from Desktop.")
  }
  guard command.program == "stim", command.arguments.first == "gc" else {
    throw ServerError(code: "bad-request", message: "Unsupported Desktop cleanup command.")
  }
  let maxInteger = 9_007_199_254_740_991
  var json = false
  var params: [String: JSONValue] = ["cwd": .string(command.cwd)]
  var seen: Set<String> = []
  var index = 1
  while index < command.arguments.count {
    let option = command.arguments[index]
    guard seen.insert(option).inserted else {
      throw ServerError(code: "bad-request", message: "Repeated Desktop cleanup option.")
    }
    switch option {
    case "--json": json = true
    case "--delete": params["delete"] = .bool(true)
    case "--worktrees": params["worktrees"] = .bool(true)
    case "--cache", "--older-than":
      index += 1
      guard index < command.arguments.count, !command.arguments[index].hasPrefix("--") else {
        throw ServerError(code: "bad-request", message: "Desktop cleanup option requires a value.")
      }
      let value = command.arguments[index]
      switch option {
      case "--cache":
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.utf16.count <= 1024 else {
          throw ServerError(code: "bad-request", message: "Choose a cache for cleanup.")
        }
        params["cache"] = .string(value)
      default:
        guard let days = Int(value), (-maxInteger...maxInteger).contains(days) else {
          throw ServerError(code: "bad-request", message: "Cleanup age must be a whole number of days.")
        }
        params["olderThan"] = .number(Double(days))
      }
    default: throw ServerError(code: "bad-request", message: "Unsupported Desktop cleanup option.")
    }
    index += 1
  }
  let (events, continuation) = AsyncThrowingStream<ServerEvent, Error>.makeStream()
  var terminal: ServerEvent?
  let unsubscribe = try client.subscribeAction(
    "desktop.gc.subscribe", params: params,
    onCancellationEvent: { event in
      if event.name == "desktop-gc-ended" { terminal = event }
    },
    onEvent: { event in
      if event.name == "desktop-gc-ended" { terminal = event }
      continuation.yield(event)
    })
  func result(_ event: ServerEvent) throws -> ServerGcResult {
    guard let exit = event.fields["exitCode"]?.number, exit == 0 || exit == 1,
      let stdout = event.fields["stdout"]?.string, let message = event.fields["message"]?.string
    else { throw ServerError(code: "bad-response", message: "Invalid cleanup result from stim-server.") }
    let data = Data(stdout.utf8)
    if exit == 0 {
      guard let payload = try? JSONDecoder().decode(JSONValue.self, from: data), case .object(let fields) = payload,
        let mode = fields["mode"]?.string, ["dry-run", "delete"].contains(mode),
        case .object? = fields["sections"]
      else { throw ServerError(code: "bad-response", message: "Invalid cleanup report from stim-server.") }
    }
    if json, !stdout.isEmpty { onLine(OutputLine(.stdout, stdout.trimmingCharacters(in: .newlines))) }
    if !message.isEmpty, !json || exit != 0 { onLine(OutputLine(exit == 0 ? .stdout : .stderr, message)) }
    return ServerGcResult(exitStatus: Int32(exit), stdout: data, message: message)
  }
  defer { Task { try? await unsubscribe() } }
  do {
    return try await withTaskCancellationHandler {
      for try await event in events {
        try Task.checkCancellation()
        switch event.name {
        case "desktop-gc-progress":
          guard let message = event.fields["message"]?.string,
            let stream = event.fields["stream"]?.string, stream == "stdout" || stream == "stderr"
          else { throw ServerError(code: "bad-response", message: "Invalid cleanup progress from stim-server.") }
          let channel: OutputChannel = stream == "stdout" && !json ? .stdout : .stderr
          for line in message.split(separator: "\n", omittingEmptySubsequences: true) {
            onLine(OutputLine(channel, String(line)))
          }
        case "desktop-gc-ended": return try result(event)
        case "error":
          if case .object(let error)? = event.fields["error"] {
            throw ServerError(code: error["code"]?.string ?? "unknown", message: error["message"]?.string ?? "Cleanup failed.")
          }
          throw ServerError(code: "bad-response", message: "The cleanup stream failed without an error.")
        default: continue
        }
      }
      throw CancellationError()
    } onCancel: {
      continuation.finish(throwing: CancellationError())
    }
  } catch {
    try await unsubscribe()
    if error is CancellationError, let terminal, terminal.fields["exitCode"]?.number == 1 { return try result(terminal) }
    throw error
  }
}
