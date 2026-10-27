import CryptoKit
import Foundation
import Testing

@testable import StimKit

private let interopRuntime = ProcessInfo.processInfo.environment["STIM_TEST_SERVER_RUNTIME"]

/// Pairs Desktop's Noise client with a real stim-server over loopback TCP, and with core's own responder for what a
/// real server cannot be made to do. `STIM_TEST_SERVER_RUNTIME` names a runtime `scripts/server-runtime.mjs` staged.
@MainActor @Suite(.serialized, .enabled(if: interopRuntime != nil))
struct NoiseInteropTests {
  static let runtime = interopRuntime
  static let responder = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("Fixtures/noise-responder.mjs").path

  /// A child process whose stdout lines the test reads.
  final class Child: @unchecked Sendable {
    let process = Process()
    private let lock = NSLock()
    private var buffer = Data()

    init(_ arguments: [String], environment: [String: String]) throws {
      let runtime = try #require(interopRuntime)
      process.executableURL = URL(fileURLWithPath: runtime).appendingPathComponent("bin/node")
      process.arguments = arguments
      process.environment = environment
      let output = Pipe()
      process.standardOutput = output
      process.standardError = FileHandle.nullDevice
      output.fileHandleForReading.readabilityHandler = { [weak self] handle in
        let data = handle.availableData
        guard let self else { return }
        self.lock.withLock { self.buffer.append(data) }
      }
      try process.run()
    }

    var lines: [String] {
      lock.withLock { String(decoding: buffer, as: UTF8.self) }.split(separator: "\n").map(String.init)
    }

    func line(_ index: Int) async throws -> [String: JSONValue] {
      for _ in 0..<600 where lines.count <= index { try await Task.sleep(for: .milliseconds(50)) }
      let text = try #require(lines.count > index ? lines[index] : nil, "no output line \(index)")
      guard case .object(let fields) = try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else {
        throw ServerError(code: "bad-output", message: text)
      }
      return fields
    }

    func stop() {
      if process.isRunning { process.terminate() }
      process.waitUntilExit()
    }
  }

  static func freePort() throws -> Int {
    let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    defer { Darwin.close(socket) }
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    try withUnsafeMutablePointer(to: &address) { pointer in
      try pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { raw in
        guard bind(socket, raw, length) == 0, getsockname(socket, raw, &length) == 0 else {
          throw ServerError(code: "port", message: "No free port.")
        }
      }
    }
    return Int(UInt16(bigEndian: address.sin_port))
  }

  static func payload(port: Int, token: String, fingerprint: String) throws -> PairingPayload {
    PairingPayload(
      name: "", endpoint: try #require(URL(string: "ws://127.0.0.1:\(port)")),
      secret: try #require(Noise.decodeSecret(token)), fingerprint: fingerprint)
  }

  static func pair(_ payload: PairingPayload, store: PairedServerStore) async throws -> PairedServer {
    try await NoisePairing.pair(
      payload, store: store, deviceName: "Interop Mac", clientName: "Stim Desktop test", clientVersion: "1", timeout: 10)
  }

  /// A client for a stored pairing; it returns once the client opens or stops retrying.
  static func connect(_ pairing: PairedServer?, endpoint: URL) async -> ServerClient {
    let client = ServerClient(
      endpoint: endpoint, clientName: "Stim Desktop test", clientVersion: "1",
      transport: NoiseClientTransport.factory(timeout: 10) { pairing?.credential })
    client.start()
    for _ in 0..<400 {
      switch client.state {
      case .open, .refused, .waiting: return client
      default: try? await Task.sleep(for: .milliseconds(25))
      }
    }
    return client
  }

  @Test func desktopPairsWithARealServerAndReconnectsWithThePinnedKey() async throws {
    let runtime = try #require(Self.runtime)
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("stim-noise-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: home) }
    let environment = [
      "HOME": home.path, "STIM_HOME": home.appendingPathComponent(".stim").path, "SHELL": "/bin/sh",
      "PATH": "/usr/bin:/bin",
    ]
    let script = URL(fileURLWithPath: runtime).appendingPathComponent("node_modules/@stim-cli/server/dist/stim-server.mjs")
      .path
    let port = try Self.freePort()
    let server = try Child([script, "--port", String(port), "--loopback-only"], environment: environment)
    defer { server.stop() }
    var ready = false
    for _ in 0..<120 where !ready {
      let health = URL(string: "http://127.0.0.1:\(port)/health")!
      if let (_, response) = try? await URLSession.shared.data(from: health) {
        ready = (response as? HTTPURLResponse)?.statusCode == 200
      }
      if !ready { try await Task.sleep(for: .milliseconds(250)) }
    }
    try #require(ready, "stim-server did not answer /health")
    let pair = try Child([script, "pair", "--port", String(port)], environment: environment)
    pair.process.waitUntilExit()
    let code = try await pair.line(0)
    let token = try #require(code["pairingToken"]?.string)
    let fingerprint = try #require(code["fingerprint"]?.string)
    let payload = try Self.payload(port: port, token: token, fingerprint: fingerprint)

    let store = InMemoryPairedServerStore()
    let pairing = try await Self.pair(payload, store: store)
    #expect(pairing.capabilities == ["read"])
    #expect(pairing.id == fingerprint)
    #expect(try store.pairings() == [pairing])

    let client = await Self.connect(pairing, endpoint: payload.endpoint)
    defer { client.stop() }
    guard case .open(let hello) = client.state else {
      Issue.record("the returning connection ended \(client.state)")
      return
    }
    #expect(hello.capabilities == ["read"])
    #expect(hello.server.id == pairing.serverID)
    _ = try await client.request("workspaces.subscribe", [:])

    await #expect(throws: ServerError(code: "already-paired", message: "Stim Desktop is already paired with this machine.")) {
      _ = try await Self.pair(payload, store: store)
    }
    await #expect(throws: NoiseClientTransport.refusal("unknown-secret")) {
      _ = try await Self.pair(payload, store: InMemoryPairedServerStore())
    }

    let other = try #require(pairing.credential)
    var replies: [JSONValue] = []
    let raw = NoiseClientTransport(url: payload.endpoint, clientKey: other.clientKey, credential: other.1) { event in
      if case .text(let text) = event, let reply = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) {
        replies.append(reply)
      }
    }
    defer { raw.close() }
    raw.send(#"{"id":1,"method":"hello","params":{"client":{"name":"raw","version":"1"}}}"#)
    raw.send(#"{"id":2,"method":"desktop.settings.get","params":{}}"#)
    for _ in 0..<400 where replies.count < 2 { try await Task.sleep(for: .milliseconds(25)) }
    guard replies.count == 2, case .object(let refused) = replies[1], case .object(let error)? = refused["error"] else {
      Issue.record("desktop.settings.get got \(replies)")
      return
    }
    #expect(error["code"] == .string("forbidden"))
  }

  @Test func aWrongFingerprintOrChangedKeyEndsTheHandshakeBeforeMessage3() async throws {
    let runtime = try #require(Self.runtime)
    let token = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    let responder = try Child([Self.responder, runtime, token], environment: ["PATH": "/usr/bin:/bin"])
    defer { responder.stop() }
    let listening = try await responder.line(0)
    let port = try #require(listening["port"]?.number.flatMap(ServerProtocol.exactInteger))
    let fingerprint = try #require(listening["fingerprint"]?.string)
    let impostor = Noise.fingerprint(Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation)

    let store = InMemoryPairedServerStore()
    await #expect(throws: NoiseClientTransport.refusal("server-key-mismatch")) {
      _ = try await Self.pair(try Self.payload(port: port, token: token, fingerprint: impostor), store: store)
    }
    #expect(try store.pairings().isEmpty)
    #expect(try await responder.line(1) == ["message3": .bool(false), "code": .string("closed")])

    let changed = PairedServer(
      endpoint: try #require(URL(string: "ws://127.0.0.1:\(port)")), name: "", serverKey: Data(repeating: 4, count: 32),
      clientKey: Curve25519.KeyAgreement.PrivateKey().rawRepresentation, serverID: nil, capabilities: [],
      pairedAt: Date())
    let client = await Self.connect(changed, endpoint: changed.endpoint)
    let state = client.state
    client.stop()
    #expect(state == .refused(NoiseClientTransport.refusal("server-key-mismatch")))
    #expect(try await responder.line(2) == ["message3": .bool(false), "code": .string("closed")])

    var verified: Data?
    let control = NoiseClientTransport(
      url: changed.endpoint, clientKey: .init(),
      credential: .firstContact(
        secret: try #require(Noise.decodeSecret(token)), fingerprint: fingerprint, deviceName: "Interop Mac", pinned: []),
      onVerified: { verified = $0 }, onEvent: { _ in })
    defer { control.close() }
    #expect(try await responder.line(3) == ["message3": .bool(true), "payload": .string(#"{"name":"Interop Mac"}"#)])
    #expect(verified.map(Noise.fingerprint) == fingerprint)
  }
}
