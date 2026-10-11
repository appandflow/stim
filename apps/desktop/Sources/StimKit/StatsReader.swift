import Foundation

/// Reads fresh stats from the local read-capable server for the CLI's Stim home.
/// The shared transport accepts at most 16 MiB per complete WebSocket message, including the JSON envelope;
/// oversized replies fail the read under that existing transport limit.
@MainActor public struct StatsReader {
  private let cli: Task<StimCLI, Never>
  private let server: @MainActor () -> (client: ServerClient, home: String)?

  public init(
    cli: Task<StimCLI, Never>, server: @escaping @MainActor () -> (client: ServerClient, home: String)?
  ) {
    self.cli = cli
    self.server = server
  }

  public func project(workspace: String) async throws -> ProjectStats {
    let cli = await cli.value
    try Task.checkCancellation()
    guard let client = readCapableServer(server(), stimHome: cli.stimHome) else {
      throw ServerError(code: "not-connected", message: "The local stim-server is not ready to read stats for this Stim home.")
    }
    let result = try await client.request("stats.get", ["workspace": .string(workspace)])
    return try decodeReporting(ProjectStats.self, from: result, source: .server)
  }

  public func machine() async throws -> MachineStats {
    let cli = await cli.value
    try Task.checkCancellation()
    guard let client = readCapableServer(server(), stimHome: cli.stimHome) else {
      throw ServerError(code: "not-connected", message: "The local stim-server is not ready to read stats for this Stim home.")
    }
    let result = try await client.request("stats.get", [:])
    return try decodeReporting(MachineStats.self, from: result, source: .server)
  }
}
