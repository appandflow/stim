import Foundation

/// The warming result or refusal, exit status and summary including failure diagnostics from the private server.
public struct ServerWorktreeWarmResult: Sendable {
  public let exitStatus: Int32
  public let stdout: Data
  public let message: String
}

/// Warms a worktree through the same-home bundled server. Cancellation awaits cleanup acknowledgement;
/// reconnect never repeats a mutation whose dispatch may already have happened.
@MainActor public func runServerWorktreeWarm(
  _ command: StimCommand, cli: StimCLI, connection: (client: ServerClient, home: String)?,
  onLine: @escaping @MainActor (OutputLine) -> Void = { _ in }
) async throws -> ServerWorktreeWarmResult {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: cli.stimHome), client.hasDesktopAuthority else {
    throw ServerError(
      code: "not-connected", message: "The bundled local stim-server is not ready to warm worktrees from this Stim home.")
  }
  guard case .open(let hello) = client.state, hello.features?.contains("desktop-worktree-warm") == true else {
    throw ServerError(code: "unsupported", message: "Update the bundled stim-server to warm worktrees from Desktop.")
  }
  guard command.program == "stim", command.arguments == ["worktree", "warm"] else {
    throw ServerError(code: "bad-request", message: "Unsupported Desktop worktree warming command.")
  }
  let params: [String: JSONValue] = ["cwd": .string(command.cwd)]
  let (events, continuation) = AsyncThrowingStream<ServerEvent, Error>.makeStream()
  var terminal: ServerEvent?
  var diagnostics: [String] = []
  let unsubscribe = try client.subscribeAction(
    "desktop.worktree.warm.subscribe", params: params,
    onCancellationEvent: { event in
      if event.name == "desktop-worktree-warm-ended" { terminal = event }
    },
    onEvent: { event in
      if event.name == "desktop-worktree-warm-ended" { terminal = event }
      continuation.yield(event)
    })
  func result(_ event: ServerEvent) throws -> ServerWorktreeWarmResult {
    guard let exit = event.fields["exitCode"]?.number, exit == 0 || exit == 1,
      let stdout = event.fields["stdout"]?.string, let message = event.fields["message"]?.string
    else { throw ServerError(code: "bad-response", message: "Invalid worktree warming result from stim-server.") }
    let data = Data(stdout.utf8)
    if exit == 0 {
      guard let payload = try? JSONDecoder().decode(JSONValue.self, from: data), case .object(let fields) = payload,
        fields["exitCode"]?.number == 0
      else { throw ServerError(code: "bad-response", message: "Invalid worktree warming result from stim-server.") }
    }
    if !message.isEmpty { onLine(OutputLine(.stderr, message)) }
    let detail = exit == 0 ? message : (diagnostics + [message]).filter { !$0.isEmpty }.joined(separator: "\n")
    return ServerWorktreeWarmResult(exitStatus: Int32(exit), stdout: data, message: detail)
  }
  defer { Task { try? await unsubscribe() } }
  do {
    return try await withTaskCancellationHandler {
      for try await event in events {
        try Task.checkCancellation()
        switch event.name {
        case "desktop-worktree-warm-progress":
          guard let message = event.fields["message"]?.string,
            let stream = event.fields["stream"]?.string, stream == "stdout" || stream == "stderr"
          else { throw ServerError(code: "bad-response", message: "Invalid worktree warming progress from stim-server.") }
          let channel: OutputChannel = stream == "stdout" ? .stdout : .stderr
          for line in message.split(separator: "\n", omittingEmptySubsequences: true) {
            diagnostics.append(String(line))
            onLine(OutputLine(channel, String(line)))
          }
        case "desktop-worktree-warm-ended": return try result(event)
        case "error":
          if case .object(let error)? = event.fields["error"] {
            throw ServerError(
              code: error["code"]?.string ?? "unknown", message: error["message"]?.string ?? "Worktree warming failed.")
          }
          throw ServerError(code: "bad-response", message: "The worktree warming stream failed without an error.")
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
