import Foundation

/// Reads fresh stats from an available read-capable server for the CLI's Stim home, otherwise through the CLI.
/// Once a server request starts, its failures and cancellation are returned without retrying through the CLI.
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
    guard let client = eligibleServer(for: cli) else { return try await cli.stats(workspace: workspace) }
    let result = try await client.request("stats.get", ["workspace": .string(workspace)])
    return try JSONDecoder().decode(ProjectStats.self, from: JSONEncoder().encode(result))
  }

  public func machine() async throws -> MachineStats {
    let cli = await cli.value
    try Task.checkCancellation()
    guard let client = eligibleServer(for: cli) else { return try await cli.machineStats() }
    let result = try await client.request("stats.get", [:])
    return try JSONDecoder().decode(MachineStats.self, from: JSONEncoder().encode(result))
  }

  private func eligibleServer(for cli: StimCLI) -> ServerClient? {
    guard let connection = server(), case .open(let hello) = connection.client.state,
      hello.capabilities.contains("read"),
      URL(fileURLWithPath: connection.home).resolvingSymlinksInPath().path
        == URL(fileURLWithPath: cli.stimHome).resolvingSymlinksInPath().path
    else { return nil }
    return connection.client
  }
}
