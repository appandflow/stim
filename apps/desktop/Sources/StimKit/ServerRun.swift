import Foundation

/// The terminal result of a private Desktop platform run. Successful stdout contains the flat platform facts.
public struct ServerRunResult: Sendable {
  public let exitStatus: Int32
  public let stdout: Data
  public let message: String
}

/// Runs a Desktop platform command through its same-home bundled server. Cancellation awaits unsubscribe;
/// a dropped connection never replays a run whose dispatch may already have happened.
@MainActor public func runServerPlatform(
  _ command: StimCommand, stimHome: String, connection: (client: ServerClient, home: String)?,
  onLine: @escaping @MainActor (OutputLine) -> Void = { _ in }
) async throws -> ServerRunResult {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: stimHome), client.hasDesktopAuthority else {
    throw ServerError(
      code: "not-connected", message: "The bundled local stim-server is not ready to run this app for this Stim home.")
  }
  guard case .open(let hello) = client.state, hello.features?.contains("desktop-run") == true else {
    throw ServerError(code: "unsupported", message: "Update the bundled stim-server to run apps from Desktop.")
  }
  guard command.program == "stim", let platform = command.arguments.first,
    ["ios", "android", "macos", "web"].contains(platform)
  else { throw ServerError(code: "bad-request", message: "Unsupported Desktop platform command.") }
  let native = platform == "ios" || platform == "android"
  var json = false
  var options: [String: JSONValue] = ["platform": .string(platform)]
  var seen: Set<String> = []
  var index = 1
  while index < command.arguments.count {
    let option = command.arguments[index]
    guard seen.insert(option).inserted else {
      throw ServerError(code: "bad-request", message: "Repeated Desktop platform option.")
    }
    switch option {
    case "--json": json = true
    case "--headed" where platform == "web": options["headed"] = .bool(true)
    case "--no-build-cache" where native: options["buildCache"] = .bool(false)
    case "--slot" where native, "--remote" where platform != "web", "--remote-build" where platform != "web":
      index += 1
      guard index < command.arguments.count, !command.arguments[index].isEmpty,
        !command.arguments[index].hasPrefix("--")
      else { throw ServerError(code: "bad-request", message: "Desktop platform option requires a value.") }
      let key = option == "--slot" ? "slot" : option == "--remote" ? "remote" : "remoteBuild"
      options[key] = .string(command.arguments[index])
    default: throw ServerError(code: "bad-request", message: "Unsupported Desktop platform option.")
    }
    index += 1
  }
  let (events, continuation) = AsyncThrowingStream<ServerEvent, Error>.makeStream()
  var terminal: ServerEvent?
  let unsubscribe = try client.subscribeAction(
    "desktop.run.subscribe", params: ["cwd": .string(command.cwd), "options": .object(options)],
    onCancellationEvent: { event in
      if event.name == "desktop-run-ended" { terminal = event }
    },
    onEvent: { event in
      if event.name == "desktop-run-ended" { terminal = event }
      continuation.yield(event)
    })
  func result(_ event: ServerEvent) throws -> ServerRunResult {
    guard let exit = event.fields["exitCode"]?.number, exit == 0 || exit == 1,
      let stdout = event.fields["stdout"]?.string, let message = event.fields["message"]?.string
    else { throw ServerError(code: "bad-response", message: "Invalid run result from stim-server.") }
    var data = Data(stdout.utf8)
    if exit == 0 {
      guard let payload = try? JSONDecoder().decode(JSONValue.self, from: data),
        case .object(let fields) = payload, fields["platform"]?.string == platform,
        case .object(let facts)? = fields["facts"]
      else { throw ServerError(code: "bad-response", message: "Invalid platform facts from stim-server.") }
      data = try JSONEncoder().encode(JSONValue.object(facts))
    }
    if json, !data.isEmpty {
      onLine(OutputLine(.stdout, String(decoding: data, as: UTF8.self).trimmingCharacters(in: .newlines)))
    }
    if !message.isEmpty, !json || exit != 0 { onLine(OutputLine(exit == 0 ? .stdout : .stderr, message)) }
    return ServerRunResult(exitStatus: Int32(exit), stdout: data, message: message)
  }
  defer { Task { try? await unsubscribe() } }
  do {
    return try await withTaskCancellationHandler {
      for try await event in events {
        try Task.checkCancellation()
        switch event.name {
        case "desktop-run-progress":
          guard let message = event.fields["message"]?.string,
            let stream = event.fields["stream"]?.string, stream == "stdout" || stream == "stderr"
          else { throw ServerError(code: "bad-response", message: "Invalid run progress from stim-server.") }
          let channel: OutputChannel = stream == "stdout" && !json ? .stdout : .stderr
          for line in message.split(separator: "\n", omittingEmptySubsequences: true) {
            onLine(OutputLine(channel, String(line)))
          }
        case "desktop-run-ended": return try result(event)
        case "error":
          if case .object(let error)? = event.fields["error"] {
            throw ServerError(code: error["code"]?.string ?? "unknown", message: error["message"]?.string ?? "Run failed.")
          }
          throw ServerError(code: "bad-response", message: "The run stream failed without an error.")
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
