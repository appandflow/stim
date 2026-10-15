import Foundation

/// Reads masked settings for a selected folder from the matching local server, without a CLI fallback.
@MainActor public func readServerSettings(
  cli: StimCLI, connection: (client: ServerClient, home: String)?, cwd: String
) async throws -> SettingsPayload {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: cli.stimHome) else {
    throw ServerError(code: "not-connected", message: "The local stim-server is not ready to read settings for this Stim home.")
  }
  guard case .open(let hello) = client.state, hello.features?.contains("desktop-settings") == true else {
    throw ServerError(code: "unsupported", message: "Update the local stim-server to read settings for selected folders.")
  }
  let result = try await client.request("desktop.settings.get", ["cwd": .string(cwd)])
  return try decodeReporting(SettingsPayload.self, from: result, source: .server, diagnostics: cli.diagnostics)
}
