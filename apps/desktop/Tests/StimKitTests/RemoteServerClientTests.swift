import Foundation
import Testing

@testable import StimKit

/// A paired server is another machine, so everything it sends is untrusted: a bad message closes the connection
/// instead of trapping, a refusal stops the retries that would feed the server's handshake lockout, and Desktop's
/// local-only methods and bootstrap never reach it.
@MainActor @Suite struct RemoteServerClientTests {
  static let remote = URL(string: "ws://100.64.0.1:7787")!

  private func client(
    _ server: ScriptedServer, endpoint: URL = remote, bootstrap: @escaping @MainActor () -> DesktopBootstrapKey? = { nil }
  ) -> (ServerClient, Retries) {
    let retries = Retries()
    let client = ServerClient(
      endpoint: endpoint, clientName: "test", clientVersion: "1", bootstrap: bootstrap,
      transport: { _, onEvent in
        server.onEvent = onEvent
        return server
      },
      scheduler: { delay, _ in
        retries.delays.append(delay)
        return {}
      })
    return (client, retries)
  }

  private func open(_ client: ServerClient) async {
    client.start()
    for _ in 0..<400 where !client.isOpen { try? await Task.sleep(for: .milliseconds(5)) }
  }

  @Test func aMessageWhoseIDOrSequenceIsNotAnExactIntegerClosesTheConnection() async {
    for message in [
      #"{"id":1e300,"result":{}}"#, #"{"id":1.5,"result":{}}"#, #"{"id":true}"#,
      #"{"event":"workspaces","subscription":"s1","seq":1e300}"#, #"{"event":"workspaces","subscription":"s1","seq":"2"}"#,
      "not json", "[1]",
    ] {
      let server = ScriptedServer()
      let (client, retries) = client(server)
      await open(client)
      #expect(client.isOpen, "\(message)")
      server.onEvent?(.text(message))
      #expect(server.closed, "\(message)")
      guard case .waiting = client.state else {
        Issue.record("\(message) left the client \(client.state)")
        continue
      }
      #expect(retries.delays == [ServerClient.minimumRetry], "\(message)")
      client.stop()
    }
  }

  @Test func aRefusalStopsRetryingAndAHandshakeFailureRetries() async {
    let server = ScriptedServer()
    let (client, retries) = client(server)
    await open(client)
    server.onEvent?(.refused(NoiseClientTransport.refusal("unknown-secret")))
    #expect(client.state == .refused(NoiseClientTransport.refusal("unknown-secret")))
    #expect(retries.delays.isEmpty)
    #expect(server.closed)

    func event(_ code: UInt16?, _ reason: String?, answered: Bool = true) -> ServerTransportEvent {
      NoiseClientTransport.closeEvent(description: "closed", code: code, reason: reason, serverAnswered: answered)
    }
    for code in ["server-key-mismatch", "unknown-secret", "unauthorized", "protocol-unsupported"] {
      guard case .refused(let refusal) = event(4401, code) else {
        Issue.record("\(code) is not a refusal")
        continue
      }
      #expect(refusal.code == code)
    }
    guard case .refused(let outdated) = event(4400, "unexpected binary frame", answered: false) else {
      Issue.record("a protocol 1 close is not a refusal")
      return
    }
    #expect(outdated.code == "server-outdated")
    for (code, reason) in [
      (UInt16(4401), "handshake-failed"), (4400, "unexpected binary frame"), (1006, nil), (4401, "bad-request"),
    ] {
      guard case .closed = event(code, reason) else {
        Issue.record("\(code) \(reason ?? "") stops retrying")
        continue
      }
    }
  }

  @Test func aRemoteServerNeverGetsTheBootstrapOrALocalOnlyMethod() async throws {
    let server = ScriptedServer()
    var bootstrapReads = 0
    let (client, _) = client(
      server,
      bootstrap: {
        bootstrapReads += 1
        return nil
      })
    await open(client)
    defer { client.stop() }
    #expect(bootstrapReads == 0)
    #expect(server.methods == ["hello"])
    #expect(server.helloParams["desktopBootstrap"] == nil)
    for method in ["desktop.settings.get", "desktop.reports.get", "route.setup", "machines.update.start", "device-host.sessions"]
    {
      await #expect(throws: ServerError(code: "forbidden", message: "\(method) is only for this Mac's own stim-server.")) {
        _ = try await client.request(method, [:])
      }
    }
    #expect(throws: ServerError.self) { _ = try client.subscribeAction("desktop.stop.subscribe", params: [:]) { _ in } }
    #expect(server.methods == ["hello"])
  }

  @Test func aForgottenPairingHasNoKeyToSend() async throws {
    let store = InMemoryPairedServerStore()
    let pairing = PairedServer(
      endpoint: Self.remote, name: "floco", serverKey: Data(repeating: 1, count: 32),
      clientKey: Data(repeating: 2, count: 32), serverID: nil, capabilities: ["read"], pairedAt: Date())
    try store.save(pairing)
    #expect(try store.pairings() == [pairing])
    try store.forget(id: pairing.id)
    #expect(try store.pairings().isEmpty)

    let client = ServerClient(
      endpoint: Self.remote, clientName: "test", clientVersion: "1",
      transport: NoiseClientTransport.factory { try? store.pairings().first { $0.id == pairing.id }?.credential })
    client.start()
    for _ in 0..<400 where client.state == .connecting { try? await Task.sleep(for: .milliseconds(5)) }
    #expect(client.state == .refused(NoiseClientTransport.refusal("unauthorized")))
  }
}

@MainActor final class Retries {
  var delays: [TimeInterval] = []
}

@MainActor private final class ScriptedServer: ServerTransport {
  var onEvent: (@MainActor (ServerTransportEvent) -> Void)?
  private(set) var methods: [String] = []
  private(set) var helloParams: [String: JSONValue] = [:]
  private(set) var closed = false

  func close() { closed = true }

  func send(_ text: String) {
    guard case .object(let request)? = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)),
      let id = request["id"], let method = request["method"]?.string
    else { return }
    methods.append(method)
    guard method == "hello" else { return }
    if case .object(let params)? = request["params"] { helloParams = params }
    let hello: JSONValue = .object([
      "protocol": .number(2),
      "server": .object(["id": .string("floco"), "name": .string("floco"), "version": .string("1"), "stim": .string("1")]),
      "capabilities": .array([.string("read")]),
      "features": .array([]),
      "actions": .array([]),
    ])
    let reply = String(decoding: try! JSONEncoder().encode(JSONValue.object(["id": id, "result": hello])), as: UTF8.self)
    Task { @MainActor in self.onEvent?(.text(reply)) }
  }
}
