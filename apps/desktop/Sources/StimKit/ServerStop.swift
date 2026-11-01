import Foundation

/// The terminal result of a private local Desktop stop, after its ordered progress output.
public struct ServerStopResult: Sendable {
  public let exitStatus: Int32
  public let stdout: Data
  public let message: String
}

/// Runs an existing Desktop stop command through the same-home bundled server. Cancellation unsubscribes;
/// the server finishes any teardown already started. A dropped connection never retries the stop.
@MainActor public func runServerStop(
  _ command: StimCommand, stimHome: String, connection: (client: ServerClient, home: String)?,
  onLine: @escaping @MainActor (OutputLine) -> Void = { _ in }
) async throws -> ServerStopResult {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: stimHome), client.hasDesktopAuthority else {
    throw ServerError(
      code: "not-connected", message: "The bundled local stim-server is not ready to stop this workspace for this Stim home.")
  }
  guard case .open(let hello) = client.state, hello.features?.contains("desktop-stop") == true else {
    throw ServerError(code: "unsupported", message: "Update the bundled stim-server to stop workspaces from Desktop.")
  }
  let json = command.arguments.contains("--json")
  let arguments = command.arguments.filter { $0 != "--json" }
  var params: [String: JSONValue] = ["cwd": .string(command.cwd)]
  guard command.program == "stim",
    arguments == ["stop"] || (arguments.count == 3 && arguments[0] == "stop" && arguments[1] == "--slot")
  else { throw ServerError(code: "bad-request", message: "Unsupported Desktop stop command.") }
  if arguments.count == 3 { params["slot"] = .string(arguments[2]) }
  let (events, continuation) = AsyncThrowingStream<ServerEvent, Error>.makeStream()
  let unsubscribe = try client.subscribeAction("desktop.stop.subscribe", params: params) { continuation.yield($0) }
  defer { Task { try? await unsubscribe() } }
  return try await withTaskCancellationHandler {
    for try await event in events {
      try Task.checkCancellation()
      switch event.name {
      case "desktop-stop-progress":
        guard let message = event.fields["message"]?.string,
          let stream = event.fields["stream"]?.string, stream == "stdout" || stream == "stderr"
        else { throw ServerError(code: "bad-response", message: "Invalid stop progress from stim-server.") }
        let channel: OutputChannel = stream == "stdout" ? .stdout : .stderr
        for line in message.split(separator: "\n", omittingEmptySubsequences: true) { onLine(OutputLine(channel, String(line))) }
      case "desktop-stop-ended":
        guard let exit = event.fields["exitCode"]?.number, exit == 0 || exit == 1,
          let stdout = event.fields["stdout"]?.string, let message = event.fields["message"]?.string
        else { throw ServerError(code: "bad-response", message: "Invalid stop result from stim-server.") }
        if json, !stdout.isEmpty { onLine(OutputLine(.stdout, stdout.trimmingCharacters(in: .newlines))) }
        if !message.isEmpty, !json || exit != 0 { onLine(OutputLine(exit == 0 ? .stdout : .stderr, message)) }
        return ServerStopResult(exitStatus: Int32(exit), stdout: Data(stdout.utf8), message: message)
      case "error":
        if case .object(let error)? = event.fields["error"] {
          throw ServerError(code: error["code"]?.string ?? "unknown", message: error["message"]?.string ?? "Stop failed.")
        }
        throw ServerError(code: "bad-response", message: "The stop stream failed without an error.")
      default: continue
      }
    }
    throw CancellationError()
  } onCancel: {
    continuation.finish(throwing: CancellationError())
  }
}
