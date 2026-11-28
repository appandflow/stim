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

  /// The server's gc report. With `fresh`, the server measures again, or joins a measurement under way, and answers
  /// with its last report meanwhile; without it, only a stale or missing report starts one.
  public func refresh(fresh: Bool) async throws -> GcReportRead {
    let environment = await environment.value
    try Task.checkCancellation()
    guard let client = readCapableServer(server(), stimHome: StimHome.path(environment: environment)) else {
      throw ServerError(code: "not-connected", message: "The local stim-server is not ready to read storage for this Stim home.")
    }
    guard case .open(let hello) = client.state, hello.desktopApi == ServerProtocol.desktopApi else {
      throw ServerError(code: "unsupported", message: "Update the local stim-server to read storage reports.")
    }
    let target: [String: JSONValue] = ["report": .string("gc")]
    let result = try await fresh ? client.report(target) : client.read("desktop.reports.get", target)
    guard case .object(let snapshot) = result else {
      throw ServerError(code: "bad-response", message: "The local stim-server did not return a storage report.")
    }
    let refreshing = snapshot["refreshing"] == .bool(true)
    guard snapshot["pending"] == .bool(false), let value = snapshot["value"], value != .null else {
      if refreshing || snapshot["pending"] == .bool(true) && snapshot["error"] == nil {
        return GcReportRead(report: nil, measuredAt: nil, refreshing: true)
      }
      throw ServerError(
        code: "bad-response",
        message: snapshot["error"]?.string ?? "The local stim-server did not return a completed storage report.")
    }
    let measuredAt = snapshot["measuredAt"]?.string.flatMap {
      try? Date($0, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true))
    }
    return GcReportRead(
      report: try decodeReporting(GcReport.self, from: value, source: .server, diagnostics: diagnostics),
      measuredAt: measuredAt, refreshing: refreshing)
  }
}

/// One answer of the server's gc report: no report while it measures for the first time.
public struct GcReportRead: Sendable {
  public let report: GcReport?
  public let measuredAt: Date?
  public let refreshing: Bool

  public init(report: GcReport?, measuredAt: Date?, refreshing: Bool) {
    self.report = report
    self.measuredAt = measuredAt
    self.refreshing = refreshing
  }
}
