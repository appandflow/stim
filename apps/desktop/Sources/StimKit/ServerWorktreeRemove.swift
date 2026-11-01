import Foundation

/// The removal result or refusal, exit status and summary including failure diagnostics from the private server.
public struct ServerWorktreeRemoveResult: Sendable {
  public let exitStatus: Int32
  public let stdout: Data
  public let message: String
}

/// Removes a worktree through the same-home bundled server. Cancellation awaits cleanup acknowledgement;
/// reconnect never repeats a mutation whose dispatch may already have happened.
@MainActor public func runServerWorktreeRemove(
  _ command: StimCommand, stimHome: String, connection: (client: ServerClient, home: String)?,
  onLine: @escaping @MainActor (OutputLine) -> Void = { _ in }
) async throws -> ServerWorktreeRemoveResult {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: stimHome), client.hasDesktopAuthority else {
    throw ServerError(
      code: "not-connected", message: "The bundled local stim-server is not ready to remove worktrees from this Stim home.")
  }
  guard case .open(let hello) = client.state, hello.features?.contains("desktop-worktree-remove") == true else {
    throw ServerError(code: "unsupported", message: "Update the bundled stim-server to remove worktrees from Desktop.")
  }
  guard command.program == "stim", Array(command.arguments.prefix(2)) == ["worktree", "remove"] else {
    throw ServerError(code: "bad-request", message: "Unsupported Desktop worktree removal command.")
  }
  var params: [String: JSONValue] = ["cwd": .string(command.cwd)]
  for argument in command.arguments.dropFirst(2) {
    if argument == "--force", params["force"] == nil {
      params["force"] = .bool(true)
    } else if argument.hasPrefix("/"), !argument.contains("\0"), argument.utf16.count <= 4096,
      params["target"] == nil
    {
      params["target"] = .string(argument)
    } else {
      throw ServerError(code: "bad-request", message: "Worktree removal requires one absolute target and optional --force.")
    }
  }
  let (events, continuation) = AsyncThrowingStream<ServerEvent, Error>.makeStream()
  var terminal: ServerEvent?
  var diagnostics: [String] = []
  let unsubscribe = try client.subscribeAction(
    "desktop.worktree.remove.subscribe", params: params,
    onCancellationEvent: { event in
      if event.name == "desktop-worktree-remove-ended" { terminal = event }
    },
    onEvent: { event in
      if event.name == "desktop-worktree-remove-ended" { terminal = event }
      continuation.yield(event)
    })
  func result(_ event: ServerEvent) throws -> ServerWorktreeRemoveResult {
    guard let exit = event.fields["exitCode"]?.number, exit == 0 || exit == 1,
      let stdout = event.fields["stdout"]?.string, let message = event.fields["message"]?.string
    else { throw ServerError(code: "bad-response", message: "Invalid worktree removal result from stim-server.") }
    let data = Data(stdout.utf8)
    if exit == 0 {
      guard let payload = try? JSONDecoder().decode(JSONValue.self, from: data), case .object(let fields) = payload,
        case .bool? = fields["removed"], fields["exitCode"]?.number == 0
      else { throw ServerError(code: "bad-response", message: "Invalid worktree removal result from stim-server.") }
    }
    if !message.isEmpty { onLine(OutputLine(.stderr, message)) }
    let detail = exit == 0 ? message : (diagnostics + [message]).filter { !$0.isEmpty }.joined(separator: "\n")
    return ServerWorktreeRemoveResult(exitStatus: Int32(exit), stdout: data, message: detail)
  }
  defer { Task { try? await unsubscribe() } }
  do {
    return try await withTaskCancellationHandler {
      for try await event in events {
        try Task.checkCancellation()
        switch event.name {
        case "desktop-worktree-remove-progress":
          guard let message = event.fields["message"]?.string,
            let stream = event.fields["stream"]?.string, stream == "stdout" || stream == "stderr"
          else { throw ServerError(code: "bad-response", message: "Invalid worktree removal progress from stim-server.") }
          let channel: OutputChannel = stream == "stdout" ? .stdout : .stderr
          for line in message.split(separator: "\n", omittingEmptySubsequences: true) {
            diagnostics.append(String(line))
            onLine(OutputLine(channel, String(line)))
          }
        case "desktop-worktree-remove-ended": return try result(event)
        case "error":
          if case .object(let error)? = event.fields["error"] {
            throw ServerError(
              code: error["code"]?.string ?? "unknown", message: error["message"]?.string ?? "Worktree removal failed.")
          }
          throw ServerError(code: "bad-response", message: "The worktree removal stream failed without an error.")
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
