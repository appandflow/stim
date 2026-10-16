import Foundation

/// The terminal result of a private local Desktop reload, after its ordered progress output.
public struct ServerReloadResult: Sendable {
  public let exitStatus: Int32
  public let stdout: Data
  public let message: String
}

/// Requests reload through the same-home bundled server. Cancellation unsubscribes; a dropped connection
/// never retries a reload whose dispatch may already have happened.
@MainActor public func runServerReload(
  _ command: StimCommand, cli: StimCLI, connection: (client: ServerClient, home: String)?,
  onLine: @escaping @MainActor (OutputLine) -> Void = { _ in }
) async throws -> ServerReloadResult {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: cli.stimHome), client.hasDesktopAuthority else {
    throw ServerError(
      code: "not-connected", message: "The bundled local stim-server is not ready to reload this workspace for this Stim home.")
  }
  guard case .open(let hello) = client.state, hello.features?.contains("desktop-reload") == true else {
    throw ServerError(code: "unsupported", message: "Update the bundled stim-server to reload workspaces from Desktop.")
  }
  let json = command.arguments.last == "--json"
  let arguments = json ? Array(command.arguments.dropLast()) : command.arguments
  guard command.program == "stim", arguments.first == "reload",
    arguments.count == 1 || (arguments.count == 2 && ["ios", "android", "web"].contains(arguments[1]))
  else { throw ServerError(code: "bad-request", message: "Unsupported Desktop reload command.") }
  var params: [String: JSONValue] = ["cwd": .string(command.cwd)]
  if arguments.count == 2 { params["platform"] = .string(arguments[1]) }
  let (events, continuation) = AsyncThrowingStream<ServerEvent, Error>.makeStream()
  let unsubscribe = try client.subscribeAction("desktop.reload.subscribe", params: params) { continuation.yield($0) }
  defer { Task { try? await unsubscribe() } }
  return try await withTaskCancellationHandler {
    for try await event in events {
      try Task.checkCancellation()
      switch event.name {
      case "desktop-reload-progress":
        guard let message = event.fields["message"]?.string,
          let stream = event.fields["stream"]?.string, stream == "stdout" || stream == "stderr"
        else { throw ServerError(code: "bad-response", message: "Invalid reload progress from stim-server.") }
        let channel: OutputChannel = stream == "stdout" ? .stdout : .stderr
        for line in message.split(separator: "\n", omittingEmptySubsequences: true) { onLine(OutputLine(channel, String(line))) }
      case "desktop-reload-ended":
        guard let exit = event.fields["exitCode"]?.number, exit == 0 || exit == 1,
          let stdout = event.fields["stdout"]?.string, let message = event.fields["message"]?.string
        else { throw ServerError(code: "bad-response", message: "Invalid reload result from stim-server.") }
        if json, !stdout.isEmpty { onLine(OutputLine(.stdout, stdout.trimmingCharacters(in: .newlines))) }
        if !message.isEmpty, !json || exit != 0 { onLine(OutputLine(exit == 0 ? .stdout : .stderr, message)) }
        return ServerReloadResult(exitStatus: Int32(exit), stdout: Data(stdout.utf8), message: message)
      case "error":
        if case .object(let error)? = event.fields["error"] {
          throw ServerError(code: error["code"]?.string ?? "unknown", message: error["message"]?.string ?? "Reload failed.")
        }
        throw ServerError(code: "bad-response", message: "The reload stream failed without an error.")
      default: continue
      }
    }
    throw CancellationError()
  } onCancel: {
    continuation.finish(throwing: CancellationError())
  }
}
