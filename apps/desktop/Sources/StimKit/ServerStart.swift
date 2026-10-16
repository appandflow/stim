import Foundation

/// The terminal result of a private local Desktop start, after its ordered progress output.
public struct ServerStartResult: Sendable {
  public let exitStatus: Int32
  public let stdout: Data
  public let message: String
}

/// Requests start through the same-home bundled server. Cancellation unsubscribes; a dropped connection
/// never retries a start whose dispatch may already have happened.
@MainActor public func runServerStart(
  _ command: StimCommand, cli: StimCLI, connection: (client: ServerClient, home: String)?,
  onLine: @escaping @MainActor (OutputLine) -> Void = { _ in }
) async throws -> ServerStartResult {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: cli.stimHome), client.hasDesktopAuthority else {
    throw ServerError(
      code: "not-connected", message: "The bundled local stim-server is not ready to start this workspace for this Stim home.")
  }
  guard case .open(let hello) = client.state, hello.features?.contains("desktop-start") == true else {
    throw ServerError(code: "unsupported", message: "Update the bundled stim-server to start workspaces from Desktop.")
  }
  guard command.program == "stim", command.arguments.first == "start" else {
    throw ServerError(code: "bad-request", message: "Unsupported Desktop start command.")
  }
  var json = false
  var params: [String: JSONValue] = ["cwd": .string(command.cwd)]
  var seen: Set<String> = []
  var index = 1
  while index < command.arguments.count {
    let option = command.arguments[index]
    guard seen.insert(option).inserted else {
      throw ServerError(code: "bad-request", message: "Repeated Desktop start option.")
    }
    switch option {
    case "--json": json = true
    case "--remote": params["remote"] = .bool(true)
    case "--reset-cache": params["resetCache"] = .bool(true)
    case "--wait":
      index += 1
      guard index < command.arguments.count, let seconds = Int(command.arguments[index]),
        seconds > 0, seconds <= 9_007_199_254_740_991
      else {
        throw ServerError(code: "bad-request", message: "Desktop start requires a positive whole wait value.")
      }
      params["waitSeconds"] = .number(Double(seconds))
    default: throw ServerError(code: "bad-request", message: "Unsupported Desktop start option.")
    }
    index += 1
  }
  let (events, continuation) = AsyncThrowingStream<ServerEvent, Error>.makeStream()
  var terminal: ServerEvent?
  let unsubscribe = try client.subscribeAction(
    "desktop.start.subscribe", params: params,
    onCancellationEvent: { event in
      if event.name == "desktop-start-ended" { terminal = event }
    }
  ) { event in
    if event.name == "desktop-start-ended" { terminal = event }
    continuation.yield(event)
  }
  func result(_ event: ServerEvent) throws -> ServerStartResult {
    guard let exit = event.fields["exitCode"]?.number, exit == 0 || exit == 1,
      let stdout = event.fields["stdout"]?.string, let message = event.fields["message"]?.string
    else { throw ServerError(code: "bad-response", message: "Invalid start result from stim-server.") }
    if json, !stdout.isEmpty { onLine(OutputLine(.stdout, stdout.trimmingCharacters(in: .newlines))) }
    if !message.isEmpty, !json || exit != 0 { onLine(OutputLine(exit == 0 ? .stdout : .stderr, message)) }
    return ServerStartResult(exitStatus: Int32(exit), stdout: Data(stdout.utf8), message: message)
  }
  defer { Task { try? await unsubscribe() } }
  do {
    return try await withTaskCancellationHandler {
      for try await event in events {
        try Task.checkCancellation()
        switch event.name {
        case "desktop-start-progress":
          guard let message = event.fields["message"]?.string,
            let stream = event.fields["stream"]?.string, stream == "stdout" || stream == "stderr"
          else { throw ServerError(code: "bad-response", message: "Invalid start progress from stim-server.") }
          let channel: OutputChannel = stream == "stdout" && !json ? .stdout : .stderr
          for line in message.split(separator: "\n", omittingEmptySubsequences: true) {
            onLine(OutputLine(channel, String(line)))
          }
        case "desktop-start-ended":
          return try result(event)
        case "error":
          if case .object(let error)? = event.fields["error"] {
            throw ServerError(code: error["code"]?.string ?? "unknown", message: error["message"]?.string ?? "Start failed.")
          }
          throw ServerError(code: "bad-response", message: "The start stream failed without an error.")
        default: continue
        }
      }
      throw CancellationError()
    } onCancel: {
      continuation.finish(throwing: CancellationError())
    }
  } catch {
    try await unsubscribe()
    if error is CancellationError, let terminal, terminal.fields["exitCode"]?.number == 1 {
      return try result(terminal)
    }
    throw error
  }
}
