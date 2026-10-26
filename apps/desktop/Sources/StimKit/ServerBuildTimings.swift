import Foundation

/// The latest offloaded build's timings from the matching local server, without a CLI fallback.
@MainActor public func readServerBuildTimings(
  cli: StimCLI, connection: (client: ServerClient, home: String)?, cwd: String
) async throws -> BuildTimings {
  try Task.checkCancellation()
  guard let client = readCapableServer(connection, stimHome: cli.stimHome) else {
    throw ServerError(
      code: "not-connected", message: "The local stim-server is not ready to read build timings for this Stim home.")
  }
  let result = try await client.request(
    "logs.query",
    [
      "workspace": .string(URL(fileURLWithPath: cwd).standardizedFileURL.resolvingSymlinksInPath().path),
      "sources": .array([.string("build")]), "grep": .string("^built on "), "tail": .number(5),
    ])
  guard case .object(let payload) = result, case .array(let records) = payload["records"] else {
    throw ServerError(code: "bad-response", message: "The local stim-server did not return build logs.")
  }
  let encoder = JSONEncoder()
  let lines = try records.map { String(decoding: try encoder.encode($0), as: UTF8.self) }.joined(separator: "\n")
  return try BuildTimings.record(Data(lines.utf8))
}
