import Foundation

/// Reads a fresh ios/android doctor report from the matching local server, without a CLI fallback.
@MainActor public func readPlatformDoctor(
  stimHome: String, diagnostics: Diagnostics = .shared, connection: (client: ServerClient, home: String)?, cwd: String,
  platform: String
) async throws -> DoctorReport {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: stimHome) else {
    throw ServerError(code: "not-connected", message: "The local stim-server is not ready to check tools for this Stim home.")
  }
  guard case .open(let hello) = client.state,
    hello.features?.contains("desktop-reports") == true,
    hello.features?.contains("desktop-report-platform") == true
  else {
    throw ServerError(code: "unsupported", message: "Update the local stim-server to check platform tools.")
  }
  _ = try await client.request("desktop.reports.invalidate", [:])
  let result = try await client.request(
    "desktop.reports.get", ["report": .string("doctor"), "cwd": .string(cwd), "platform": .string(platform)])
  guard case .object(let snapshot) = result, snapshot["pending"] == .bool(false), let value = snapshot["value"] else {
    throw ServerError(code: "bad-response", message: "The local stim-server did not return a completed tool report.")
  }
  return try decodeReporting(DoctorReport.self, from: value, source: .server, diagnostics: diagnostics)
}
