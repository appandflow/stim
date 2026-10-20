import Foundation

/// A settings mutation's typed outcome and exact masked server payload.
public struct ServerSettingWrite: Sendable {
  public let result: SettingsWriteResult
  public let payload: JSONValue
}

/// Sends one write through the proved same-home Desktop connection. Cancellation ends the local await;
/// sent work remains bounded by the server and is never automatically retried.
@MainActor public func writeServerSetting(
  _ key: String, value: String?, scope: SettingScope, cwd: String,
  cli: StimCLI, connection: (client: ServerClient, home: String)?
) async throws -> ServerSettingWrite {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: cli.stimHome), client.hasDesktopAuthority else {
    throw ServerError(
      code: "not-connected", message: "The bundled local stim-server is not ready to change settings for this Stim home.")
  }
  guard case .open(let hello) = client.state, hello.features?.contains("desktop-settings-write") == true else {
    throw ServerError(code: "unsupported", message: "Update the bundled stim-server to change settings from Desktop.")
  }
  var params: [String: JSONValue] = [
    "cwd": .string(cwd), "key": .string(key), "scope": .string(scope.rawValue),
    "action": .string(value == nil ? "unset" : "set"),
  ]
  if let value { params["value"] = .string(value) }
  let payload = try await client.request("desktop.settings.write", params)
  try Task.checkCancellation()
  let result: SettingsWriteResult
  if case .object(let fields) = payload, fields["code"] != nil {
    result = .refused(try decodeReporting(SettingsRefusal.self, from: payload, source: .server, diagnostics: cli.diagnostics))
  } else {
    result = .written(
      try decodeReporting(SettingsWritePayload.self, from: payload, source: .server, diagnostics: cli.diagnostics).setting)
  }
  return ServerSettingWrite(result: result, payload: payload)
}

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

/// Reads the settings fields defined by the matching local server, without consulting an external CLI installation.
@MainActor public func readServerSettingsSchema(
  cli: StimCLI, connection: (client: ServerClient, home: String)?
) async throws -> [SettingField] {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: cli.stimHome) else {
    throw ServerError(
      code: "not-connected", message: "The local stim-server is not ready to describe settings for this Stim home.")
  }
  guard case .open(let hello) = client.state, hello.features?.contains("desktop-settings-schema") == true else {
    throw ServerError(code: "unsupported", message: "Update the local stim-server to describe settings from Desktop.")
  }
  let schema = try await client.request("desktop.settings.schema", [:])
  try Task.checkCancellation()
  return try SettingsSchema.fields(from: JSONEncoder().encode(schema))
}
