import Foundation

/// Reads a next-build preview through the same-home bundled server without a CLI fallback.
/// Cancellation waits for the server to drain this request without disconnecting the shared client.
@MainActor public func readServerBuildPlan(
  platform: String, workspace: String, cli: StimCLI, connection: (client: ServerClient, home: String)?
) async throws -> BuildPlanOutcome {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: cli.stimHome), client.hasDesktopAuthority else {
    throw ServerError(
      code: "not-connected", message: "The bundled local stim-server is not ready to check builds for this Stim home.")
  }
  guard case .open(let hello) = client.state, hello.features?.contains("desktop-plan") == true else {
    throw ServerError(code: "unsupported", message: "Update the bundled stim-server to check builds from Desktop.")
  }
  let request = UUID().uuidString
  let result: JSONValue
  do {
    result = try await client.request(
      "desktop.plan.get", ["cwd": .string(workspace), "platform": .string(platform), "request": .string(request)])
  } catch is CancellationError {
    let cleanup = Task { try await client.request("desktop.plan.cancel", ["request": .string(request)]) }
    if case .object(let fields) = try await cleanup.value, let refusal = fields["refusal"] {
      return .refused(try decodeReporting(CommandRefusal.self, from: refusal, source: .server, diagnostics: cli.diagnostics))
    }
    throw CancellationError()
  }
  if case .object(let fields) = result, fields["code"] != nil {
    let refusal = try decodeReporting(CommandRefusal.self, from: result, source: .server, diagnostics: cli.diagnostics)
    if refusal.code == "STIM_CLAIM_UNAVAILABLE" {
      let acknowledgement = Task { try await client.request("desktop.plan.cancel", ["request": .string(request)]) }
      _ = try? await acknowledgement.value
    }
    return .refused(refusal)
  }
  try Task.checkCancellation()
  let plan = try decodeReporting(BuildPlan.self, from: result, source: .server, diagnostics: cli.diagnostics)
  guard plan.platform == platform else {
    throw ServerError(code: "bad-response", message: "The local stim-server returned a plan for another platform.")
  }
  return .plan(plan)
}
