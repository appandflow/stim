import Foundation

/// Reads machine-wide build or cleanup history from the matching local server, without a CLI fallback.
@MainActor public func readServerMachineHistory(
  report: String, stimHome: String, connection: (client: ServerClient, home: String)?
) async throws -> Data {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: stimHome) else {
    throw ServerError(code: "not-connected", message: "The local stim-server is not ready to read history for this Stim home.")
  }
  guard case .open(let hello) = client.state, hello.desktopApi == ServerProtocol.desktopApi else {
    throw ServerError(code: "unsupported", message: "Update the local stim-server to read build and cleanup history.")
  }
  let result = try await client.report(["report": .string(report)])
  guard case .object(let snapshot) = result, snapshot["pending"] == .bool(false),
    case .object(let value)? = snapshot["value"], case .array(let records)? = value["records"]
  else {
    throw ServerError(code: "bad-response", message: "The local stim-server did not return completed history.")
  }
  let encoder = JSONEncoder()
  return Data(try records.map { String(decoding: try encoder.encode($0), as: UTF8.self) }.joined(separator: "\n").utf8)
}
