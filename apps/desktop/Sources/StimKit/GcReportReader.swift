import Foundation

/// Reads a fresh GC dry run through the matching local server, without a CLI fallback.
@MainActor public struct GcReportReader {
  private let environment: Task<[String: String], Never>
  private let diagnostics: Diagnostics
  private let server: @MainActor () -> (client: ServerClient, home: String)?

  public init(
    environment: Task<[String: String], Never>, diagnostics: Diagnostics = .shared,
    server: @escaping @MainActor () -> (client: ServerClient, home: String)?
  ) {
    self.environment = environment
    self.diagnostics = diagnostics
    self.server = server
  }

  public func refresh() async throws -> GcReport {
    let environment = await environment.value
    try Task.checkCancellation()
    guard let client = readCapableServer(server(), stimHome: StimHome.path(environment: environment)) else {
      throw ServerError(code: "not-connected", message: "The local stim-server is not ready to read storage for this Stim home.")
    }
    guard case .open(let hello) = client.state, hello.features?.contains("desktop-reports") == true else {
      throw ServerError(code: "unsupported", message: "Update the local stim-server to read storage reports.")
    }
    _ = try await client.request("desktop.reports.invalidate", [:])
    let result = try await client.request("desktop.reports.get", ["report": .string("gc")])
    guard case .object(let snapshot) = result, snapshot["pending"] == .bool(false), let value = snapshot["value"] else {
      throw ServerError(code: "bad-response", message: "The local stim-server did not return a completed storage report.")
    }
    return try decodeReporting(GcReport.self, from: value, source: .server, diagnostics: diagnostics)
  }
}
