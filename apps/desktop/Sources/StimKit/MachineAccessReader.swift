import Foundation

/// Reads machine access from the matching local server; explicit access requests retain the CLI's setup-ticket flow.
@MainActor public struct MachineAccessReader {
  private let cli: Task<StimCLI, Never>
  private let server: @MainActor () -> (client: ServerClient, home: String)?

  public init(
    cli: Task<StimCLI, Never>, server: @escaping @MainActor () -> (client: ServerClient, home: String)?
  ) {
    self.cli = cli
    self.server = server
  }

  public func report(cwd: String, ask: Bool, extraEnvironment: [String: String] = [:]) async throws -> DoctorReport {
    let cli = await cli.value
    try Task.checkCancellation()
    if ask { return try await cli.machineAccess(cwd: cwd, ask: true, extraEnvironment: extraEnvironment) }
    guard let client = readCapableServer(server(), stimHome: cli.stimHome) else {
      throw ServerError(
        code: "not-connected", message: "The local stim-server is not ready to check machine access for this Stim home.")
    }
    guard case .open(let hello) = client.state, hello.features?.contains("desktop-reports") == true else {
      throw ServerError(code: "unsupported", message: "Update the local stim-server to read setup reports.")
    }
    _ = try await client.request("desktop.reports.invalidate", [:])
    let result = try await client.request("desktop.reports.get", ["report": .string("doctor"), "cwd": .string(cwd)])
    guard case .object(let snapshot) = result, snapshot["pending"] == .bool(false), let value = snapshot["value"] else {
      throw ServerError(code: "bad-response", message: "The local stim-server did not return a completed setup report.")
    }
    return try decodeReporting(DoctorReport.self, from: value, source: .server, diagnostics: cli.diagnostics)
  }
}
