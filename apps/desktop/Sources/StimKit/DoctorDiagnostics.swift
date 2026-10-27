import Foundation

/// Reads producer versions and complete doctor JSON from the matching local server, preserving report fields.
@MainActor public func readDoctorDiagnostics(
  cli: StimCLI, connection: (client: ServerClient, home: String)?, cwd: String
) async -> (stimVersion: String?, serverVersion: String?, report: String) {
  guard let client = readCapableServer(connection, stimHome: cli.stimHome), case .open(let hello) = client.state else {
    return (nil, nil, "Doctor report unavailable: the local stim-server is not ready for this Stim home.")
  }
  let report: String
  do {
    guard hello.features?.contains("desktop-reports") == true else {
      throw ServerError(code: "unsupported", message: "Update the local stim-server to read setup reports.")
    }
    let result = try await client.report(["report": .string("doctor"), "cwd": .string(cwd)])
    guard case .object(let snapshot) = result, snapshot["pending"] == .bool(false), let value = snapshot["value"] else {
      throw ServerError(code: "bad-response", message: "The local stim-server did not return a completed setup report.")
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    report = String(decoding: try encoder.encode(value), as: UTF8.self)
  } catch {
    report = "Doctor report unavailable: \(error.localizedDescription)"
  }
  return (hello.server.stim, hello.server.version, report)
}
