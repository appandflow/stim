import Foundation
import Testing

@testable import StimKit

@MainActor @Suite struct ServerReadsTests {
  private func open(_ server: BusyServer) async -> ServerClient {
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/server-reads-test.sock"), clientName: "test", clientVersion: "1",
      transport: { _, onEvent in
        server.onEvent = onEvent
        return server
      })
    client.busyRetryDelays = [.milliseconds(1), .milliseconds(1), .milliseconds(1)]
    client.start()
    for _ in 0..<400 where !client.isOpen { try? await Task.sleep(for: .milliseconds(5)) }
    return client
  }

  @Test func settingsReadsRetryARefusalFromAFullConnection() async throws {
    let server = BusyServer(refusals: ["desktop.settings.get": 2])
    let client = await open(server)
    defer { client.stop() }
    let cli = Task { StimCLI(environment: ["PATH": "/nonexistent", "STIM_HOME": "/tmp/server-reads-home"]) }
    let payload = try await readServerSettings(
      cli: await cli.value, connection: (client, "/tmp/server-reads-home"), cwd: "/tmp")
    #expect(payload.entry("remote.machines")?.value.strings == [])
    #expect(server.sent.filter { $0.method == "desktop.settings.get" }.count == 3)
  }

  @Test func aConnectionThatStaysFullEndsWithAnActionableError() async throws {
    let server = BusyServer(refusals: ["stats.get": 10])
    let client = await open(server)
    defer { client.stop() }
    await #expect(throws: ServerError.self) { try await client.read("stats.get", [:]) }
    do {
      _ = try await client.read("stats.get", [:])
    } catch let error as ServerError {
      #expect(error.code == "limit-exceeded")
      #expect(error.message.hasPrefix("The local stim-server is still busy"))
    }
  }

  @Test func concurrentReadsOfOneReportShareOneRequestAndInvalidateOnlyThatTarget() async throws {
    let server = BusyServer(refusals: ["desktop.reports.get": 1], holdReports: true)
    let client = await open(server)
    defer { client.stop() }
    let target: [String: JSONValue] = ["report": .string("doctor"), "cwd": .string("/app")]
    async let first = client.report(target)
    async let second = client.report(target)
    async let other = client.report(["report": .string("gc")])
    for _ in 0..<400 where server.heldReports.count < 2 { try? await Task.sleep(for: .milliseconds(5)) }
    server.releaseReports()
    let results = try await [first, second, other]
    #expect(results[0] == results[1])
    #expect(server.sent.filter { $0.method == "desktop.reports.get" && $0.params["cwd"] == .string("/app") }.count == 2)
    #expect(server.heldReports.isEmpty)
    #expect(
      server.sent.filter { $0.method == "desktop.reports.invalidate" }.map(\.params) == [
        target, ["report": .string("gc")],
      ])
  }

  @Test func anOlderServerGetsTheWholeInvalidation() async throws {
    let server = BusyServer(refusals: [:], features: ["desktop-reports"])
    let client = await open(server)
    defer { client.stop() }
    _ = try await client.report(["report": .string("gc")])
    #expect(server.sent.filter { $0.method == "desktop.reports.invalidate" }.map(\.params) == [[:]])
  }
}

@MainActor private final class BusyServer: ServerTransport {
  struct Sent {
    var method: String
    var params: [String: JSONValue]
  }

  var onEvent: (@MainActor (ServerTransportEvent) -> Void)?
  private(set) var sent: [Sent] = []
  private(set) var heldReports: [JSONValue] = []
  private var refusals: [String: Int]
  private let holdReports: Bool
  private let features: [String]

  init(
    refusals: [String: Int], holdReports: Bool = false,
    features: [String] = ["desktop-reports", "desktop-settings", "desktop-report-invalidate-target"]
  ) {
    self.refusals = refusals
    self.holdReports = holdReports
    self.features = features
  }

  func close() {}

  func send(_ text: String) {
    guard case .object(let request)? = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)),
      let id = request["id"], case .string(let method)? = request["method"]
    else { return }
    var params: [String: JSONValue] = [:]
    if case .object(let given)? = request["params"] { params = given }
    if method != "hello" { sent.append(Sent(method: method, params: params)) }
    if let left = refusals[method], left > 0 {
      refusals[method] = left - 1
      return answer(
        [
          "id": id,
          "error": .object(["code": .string("limit-exceeded"), "message": .string("A connection can run 4 requests at a time.")]),
        ])
    }
    switch method {
    case "hello":
      reply(
        id,
        .object([
          "protocol": .number(1),
          "server": .object(["id": .string("home"), "name": .string("Mac"), "version": .string("1"), "stim": .string("1")]),
          "capabilities": .array([.string("read")]),
          "features": .array(features.map(JSONValue.string)),
        ]))
    case "desktop.reports.get":
      if holdReports { heldReports.append(id) } else { reply(id, snapshot) }
    case "desktop.settings.get":
      reply(
        id,
        .object([
          "files": .object([:]), "unknown": .array([]),
          "settings": .array([
            .object(["key": .string("remote.machines"), "value": .array([]), "layers": .object([:])])
          ]),
        ]))
    default:
      reply(id, .object([:]))
    }
  }

  func releaseReports() {
    for id in heldReports { reply(id, snapshot) }
    heldReports = []
  }

  private var snapshot: JSONValue {
    .object(["pending": .bool(false), "value": .object(["project": .string("/app"), "findings": .array([])])])
  }

  private func reply(_ id: JSONValue, _ result: JSONValue) { answer(["id": id, "result": result]) }

  private func answer(_ message: [String: JSONValue]) {
    guard let data = try? JSONEncoder().encode(JSONValue.object(message)) else { return }
    onEvent?(.text(String(decoding: data, as: UTF8.self)))
  }
}
