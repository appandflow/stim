import CryptoKit
import Foundation
import StimKit
import XCTest

@testable import StimDesktop

@MainActor private final class HelloAnswer: ServerTransport {
  let serverID: String
  var onEvent: (@MainActor (ServerTransportEvent) -> Void)?

  init(serverID: String) { self.serverID = serverID }

  func close() {}

  func send(_ text: String) {
    guard case .object(let request)? = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)),
      let id = request["id"], request["method"]?.string == "hello"
    else { return }
    let result: JSONValue = .object([
      "protocol": .number(2),
      "server": .object([
        "id": .string(serverID), "name": .string("floco"), "version": .string("1"), "stim": .string("1"),
      ]),
      "capabilities": .array([.string("read")]),
    ])
    let reply = String(decoding: try! JSONEncoder().encode(JSONValue.object(["id": id, "result": result])), as: UTF8.self)
    Task { @MainActor in self.onEvent?(.text(reply)) }
  }
}

@MainActor final class PairedServerSessionsTests: XCTestCase {
  private var clientsMade = 0

  private func servers(answeringAs serverID: String, pairing: PairedServer) throws -> PairedServers {
    let store = InMemoryPairedServerStore()
    try store.save(pairing)
    return PairedServers(
      PairedServers.Dependencies(
        store: store,
        makeClient: { [unowned self] pairing in
          clientsMade += 1
          return ServerClient(
            endpoint: pairing.endpoint, clientName: "test", clientVersion: "1",
            transport: { _, onEvent in
              let transport = HelloAnswer(serverID: serverID)
              transport.onEvent = onEvent
              return transport
            }, scheduler: { _, _ in {} })
        },
        pair: { _ in throw CancellationError() }, localServerID: { nil }))
  }

  private func pairing(name: String) -> PairedServer {
    PairedServer(
      endpoint: URL(string: "wss://floco.tail7f5754.ts.net:7443")!, name: name, serverKey: Data(repeating: 3, count: 32),
      clientKey: Curve25519.KeyAgreement.PrivateKey().rawRepresentation, serverID: nil, capabilities: [],
      pairedAt: Date())
  }

  private func until(_ done: () -> Bool) async {
    for _ in 0..<400 where !done() { try? await Task.sleep(for: .milliseconds(5)) }
  }

  func testAPairingKeepsOneConnectionAndItsSessionWhenItsNameIsFilledInThenForgetEndsIt() async throws {
    let unnamed = pairing(name: "")
    let servers = try servers(answeringAs: "floco-id", pairing: unnamed)
    let sessions = PairedServerSessions()
    servers.onChange = { sessions.sync(servers, localServerID: "this-mac") }
    servers.start()

    let first = try XCTUnwrap(sessions.sessions[unnamed.id])
    XCTAssertTrue(first.client === servers.client(for: unnamed.id))
    await until { first.isOpen }
    XCTAssertTrue(first.isOpen)
    XCTAssertTrue(sessions.sessions[unnamed.id] === first)
    XCTAssertEqual(first.name, "floco")
    XCTAssertEqual(first.owner, .paired(unnamed.id))
    XCTAssertEqual(clientsMade, 1)

    servers.forget(id: unnamed.id)
    XCTAssertNil(sessions.sessions[unnamed.id])
    XCTAssertTrue(sessions.entries.isEmpty)
    servers.stop()
  }

  func testAPairingWhoseServerSaysItIsThisMacsOwnGetsNoSession() async throws {
    let own = pairing(name: "this mac")
    let servers = try servers(answeringAs: "this-mac", pairing: own)
    let sessions = PairedServerSessions()
    servers.onChange = { sessions.sync(servers, localServerID: "this-mac") }
    servers.start()
    XCTAssertNotNil(sessions.sessions[own.id])

    await until { servers.client(for: own.id)?.isOpen == true }
    XCTAssertNil(sessions.sessions[own.id])
    XCTAssertTrue(sessions.entries.isEmpty)
    servers.stop()
  }
}
