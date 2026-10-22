import Foundation

/// Reads and requests machine access through the matching local server.
@MainActor public struct MachineAccessReader {
  private let cli: Task<StimCLI, Never>
  private let server: @MainActor () -> (client: ServerClient, home: String)?

  public init(
    cli: Task<StimCLI, Never>, server: @escaping @MainActor () -> (client: ServerClient, home: String)?
  ) {
    self.cli = cli
    self.server = server
  }

  public func report(cwd: String, ask: Bool, ticket: String? = nil) async throws -> DoctorReport {
    let cli = await cli.value
    try Task.checkCancellation()
    if ask { return try await request(cwd: cwd, ticket: ticket, cli: cli) }
    guard let client = readCapableServer(server(), stimHome: cli.stimHome) else {
      throw ServerError(
        code: "not-connected", message: "The local stim-server is not ready to check machine access for this Stim home.")
    }
    guard case .open(let hello) = client.state, hello.features?.contains("desktop-reports") == true else {
      throw ServerError(code: "unsupported", message: "Update the local stim-server to read setup reports.")
    }
    let result = try await client.report(["report": .string("doctor"), "cwd": .string(cwd)])
    guard case .object(let snapshot) = result, snapshot["pending"] == .bool(false), let value = snapshot["value"] else {
      throw ServerError(code: "bad-response", message: "The local stim-server did not return a completed setup report.")
    }
    return try decodeReporting(DoctorReport.self, from: value, source: .server, diagnostics: cli.diagnostics)
  }

  private func request(cwd: String, ticket: String?, cli: StimCLI) async throws -> DoctorReport {
    guard let client = readCapableServer(server(), stimHome: cli.stimHome), client.hasDesktopAuthority else {
      throw ServerError(
        code: "not-connected", message: "The bundled local stim-server is not ready to request machine access for this Stim home."
      )
    }
    guard case .open(let hello) = client.state, hello.features?.contains("desktop-machine-access") == true else {
      throw ServerError(code: "unsupported", message: "Update the bundled stim-server to request machine access from Desktop.")
    }
    var params: [String: JSONValue] = ["cwd": .string(cwd)]
    if let ticket { params["ticket"] = .string(ticket) }
    let (events, continuation) = AsyncThrowingStream<ServerEvent, Error>.makeStream()
    var terminal: ServerEvent?
    let unsubscribe = try client.subscribeAction(
      "desktop.machine-access.subscribe", params: params,
      onCancellationEvent: { event in
        if event.name == "desktop-machine-access-ended" { terminal = event }
      },
      onEvent: { event in
        if event.name == "desktop-machine-access-ended" { terminal = event }
        continuation.yield(event)
      })
    func result(_ event: ServerEvent) throws -> DoctorReport {
      guard let exit = event.fields["exitCode"]?.number, exit == 0 || exit == 1,
        let stdout = event.fields["stdout"]?.string, let message = event.fields["message"]?.string
      else { throw ServerError(code: "bad-response", message: "Invalid machine access result from stim-server.") }
      let data = Data(stdout.utf8)
      if exit == 1 {
        let failure = try? JSONDecoder().decode([String: JSONValue].self, from: data)
        throw ServerError(code: failure?["code"]?.string ?? "action-failed", message: failure?["message"]?.string ?? message)
      }
      return try decodeReporting(DoctorReport.self, from: data, source: .server, diagnostics: cli.diagnostics)
    }
    defer { Task { try? await unsubscribe() } }
    do {
      return try await withTaskCancellationHandler {
        for try await event in events {
          try Task.checkCancellation()
          switch event.name {
          case "desktop-machine-access-ended": return try result(event)
          case "error":
            let failure: [String: JSONValue]
            if case .object(let fields)? = event.fields["error"] { failure = fields } else { failure = [:] }
            throw ServerError(
              code: failure["code"]?.string ?? "unknown",
              message: failure["message"]?.string ?? "Machine access request failed.")
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
}
