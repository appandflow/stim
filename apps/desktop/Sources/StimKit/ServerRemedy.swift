import Foundation

/// The repair result or refusal after the private server completes cleanup.
public struct ServerRemedyResult: Sendable {
  public let exitStatus: Int32
  public let stdout: Data
  public let message: String
}

/// Runs an advertised repair through the same-home bundled server. Cancellation awaits cleanup acknowledgement;
/// reconnect never repeats a mutation whose dispatch may already have happened.
@MainActor public func runServerRemedy(
  _ command: StimCommand, stimHome: String, connection: (client: ServerClient, home: String)?,
  onLine: @escaping @MainActor (OutputLine) -> Void = { _ in }
) async throws -> ServerRemedyResult {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: stimHome), client.hasDesktopAuthority else {
    throw ServerError(
      code: "not-connected",
      message: "The bundled local stim-server is not ready to repair projects or release device leases from this Stim home.")
  }
  guard case .open(let hello) = client.state, hello.features?.contains("desktop-remedy") == true else {
    throw ServerError(
      code: "unsupported", message: "Update the bundled stim-server to repair projects or release device leases from Desktop.")
  }
  guard command.program == "stim" else {
    throw ServerError(code: "bad-request", message: "Unsupported Desktop repair command.")
  }
  let json = command.arguments.contains("--json")
  var arguments = command.arguments.filter { $0 != "--json" }
  var params: [String: JSONValue] = ["cwd": .string(command.cwd)]
  if arguments.first == "doctor", arguments.filter({ $0 == "--fix" }).count == 1 {
    arguments.removeAll { $0 == "--fix" }
    params["action"] = .string("doctor-fix")
    arguments.removeFirst()
  } else if Array(arguments.prefix(2)) == ["device", "unlock"] {
    params["action"] = .string("device-unlock")
    arguments.removeFirst(2)
    if let platform = arguments.first, ["ios", "android"].contains(platform) {
      params["platform"] = .string(platform)
      arguments.removeFirst()
    }
  } else {
    throw ServerError(code: "bad-request", message: "Unsupported Desktop repair command.")
  }
  if arguments.count == 2, arguments[0] == "--platform", params["action"] == .string("doctor-fix"),
    ["ios", "android"].contains(arguments[1])
  {
    params["platform"] = .string(arguments[1])
  } else if arguments.count == 2, arguments[0] == "--slot", params["action"] == .string("device-unlock") {
    params["slot"] = .string(arguments[1])
  } else if !arguments.isEmpty {
    throw ServerError(code: "bad-request", message: "Unsupported Desktop repair command.")
  }
  let (events, continuation) = AsyncThrowingStream<ServerEvent, Error>.makeStream()
  var terminal: ServerEvent?
  var diagnostics: [String] = []
  let unsubscribe = try client.subscribeAction(
    "desktop.remedy.subscribe", params: params,
    onCancellationEvent: { event in
      if event.name == "desktop-remedy-ended" { terminal = event }
    },
    onEvent: { event in
      if event.name == "desktop-remedy-ended" { terminal = event }
      continuation.yield(event)
    })
  func result(_ event: ServerEvent) throws -> ServerRemedyResult {
    guard let exit = event.fields["exitCode"]?.number, exit == 0 || exit == 1,
      let stdout = event.fields["stdout"]?.string, let message = event.fields["message"]?.string
    else { throw ServerError(code: "bad-response", message: "Invalid repair result from stim-server.") }
    let data = Data(stdout.utf8)
    if exit == 0 {
      guard let payload = try? JSONDecoder().decode(JSONValue.self, from: data) else {
        throw ServerError(code: "bad-response", message: "Invalid repair result from stim-server.")
      }
      switch payload {
      case .object, .array: break
      default: throw ServerError(code: "bad-response", message: "Invalid repair result from stim-server.")
      }
    }
    if json, !stdout.isEmpty {
      onLine(OutputLine(.stdout, stdout.trimmingCharacters(in: .newlines)))
    } else if params["action"] == .string("doctor-fix"), let report = DoctorReport.decode(data) {
      for finding in report.findings {
        onLine(OutputLine(.stdout, "\(finding.title): \(finding.detail)"))
        if let fix = finding.fix { onLine(OutputLine(.stdout, fix)) }
      }
      onLine(OutputLine(.stdout, "Doctor completed with \(report.findings.count) finding(s)."))
    }
    if !message.isEmpty { onLine(OutputLine(.stderr, message)) }
    let detail = exit == 0 ? message : (diagnostics + [message]).filter { !$0.isEmpty }.joined(separator: "\n")
    return ServerRemedyResult(exitStatus: Int32(exit), stdout: data, message: detail)
  }
  defer { Task { try? await unsubscribe() } }
  do {
    return try await withTaskCancellationHandler {
      for try await event in events {
        try Task.checkCancellation()
        switch event.name {
        case "desktop-remedy-progress":
          guard let message = event.fields["message"]?.string,
            let stream = event.fields["stream"]?.string, stream == "stdout" || stream == "stderr"
          else { throw ServerError(code: "bad-response", message: "Invalid repair progress from stim-server.") }
          let channel: OutputChannel = stream == "stdout" ? .stdout : .stderr
          for line in message.split(separator: "\n", omittingEmptySubsequences: true) {
            diagnostics.append(String(line))
            onLine(OutputLine(channel, String(line)))
          }
        case "desktop-remedy-ended": return try result(event)
        case "error":
          if case .object(let error)? = event.fields["error"] {
            throw ServerError(
              code: error["code"]?.string ?? "unknown", message: error["message"]?.string ?? "Repair failed.")
          }
          throw ServerError(code: "bad-response", message: "The repair stream failed without an error.")
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
