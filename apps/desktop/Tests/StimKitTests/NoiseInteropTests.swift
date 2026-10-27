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

  static func outcome(_ payload: PairingPayload, _ store: PairedServerStore) async -> Result<PairedServer, ServerError> {
    do {
      return .success(try await pair(payload, store: store))
    } catch {
      return .failure(error as? ServerError ?? ServerError(code: "other", message: "\(error)"))
    }
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

  /// A real `stim-server --loopback-only` in a private home, and a way to get a fresh single-use pairing code.
  @MainActor final class RunningServer {
    let port: Int
    private let server: Child
    private let script: String
    private let environment: [String: String]
    private let home: URL

    init() async throws {
      let runtime = try #require(interopRuntime)
      home = FileManager.default.temporaryDirectory.appendingPathComponent("stim-noise-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
      environment = [
        "HOME": home.path, "STIM_HOME": home.appendingPathComponent(".stim").path, "SHELL": "/bin/sh",
        "PATH": "/usr/bin:/bin",
      ]
      script =
        URL(fileURLWithPath: runtime).appendingPathComponent("node_modules/@stim-cli/server/dist/stim-server.mjs")
        .path
      port = try NoiseInteropTests.freePort()
      server = try Child([script, "--port", String(port), "--loopback-only"], environment: environment)
      var ready = false
      for _ in 0..<120 where !ready {
        let health = URL(string: "http://127.0.0.1:\(port)/health")!
        if let (_, response) = try? await URLSession.shared.data(from: health) {
          ready = (response as? HTTPURLResponse)?.statusCode == 200
        }
        if !ready { try await Task.sleep(for: .milliseconds(250)) }
      }
      guard ready else {
        stop()
        throw ServerError(code: "not-ready", message: "stim-server did not answer /health")
      }
    }

    func stop() {
      server.stop()
      try? FileManager.default.removeItem(at: home)
    }

    func payload(control: Bool = false) async throws -> PairingPayload {
      let pair = try Child(
        [script, "pair", "--port", String(port)] + (control ? ["--control"] : []), environment: environment)
      pair.process.waitUntilExit()
      let code = try await pair.line(0)
      let token = try #require(code["pairingToken"]?.string)
      let fingerprint = try #require(code["fingerprint"]?.string)
      return try NoiseInteropTests.payload(port: port, token: token, fingerprint: fingerprint)
    }

    /// A Stim workspace this server's home lists, by the canonical path a status payload reports.
    func registerWorkspace() throws -> String {
      let directory = home.appendingPathComponent("workspace")
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let path = try #require(realpath(directory.path, nil).map { String(cString: $0) })
      let config = try JSONEncoder().encode(["projects": [path: [String: String]()]])
      try config.write(to: home.appendingPathComponent(".stim/config.json"))
      return path
    }

    func grant(_ deviceID: String, _ scope: String) async throws {
      let grant = try Child([script, "devices", "grant", deviceID, scope], environment: environment)
      grant.process.waitUntilExit()
      #expect(grant.process.terminationStatus == 0)
    }
  }

  static func code(_ work: () async throws -> JSONValue) async -> String? {
    do {
      _ = try await work()
      return nil
    } catch {
      return (error as? ServerError)?.code ?? "\(error)"
    }
  }

  @Test func desktopPairsWithARealServerAndReconnectsWithThePinnedKey() async throws {
    let server = try await RunningServer()
    defer { server.stop() }
    let payload = try await server.payload()
    let fingerprint = payload.fingerprint

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

  @Test func onlyAControlPairingRunsTheServersActionsAndLosesThemOnceTheServerTakesControlBack() async throws {
    let server = try await RunningServer()
    defer { server.stop() }
    let workspace = try server.registerWorkspace()
    let stop: [String: JSONValue] = ["action": .string("stop"), "workspace": .string(workspace)]
    let begin: [String: JSONValue] = ["workspace": .string(workspace), "platform": .string("ios"), "slot": .string("default")]

    let reading = try await Self.pair(try await server.payload(), store: InMemoryPairedServerStore())
    let reader = await Self.connect(reading, endpoint: reading.endpoint)
    defer { reader.stop() }
    #expect(PairedAccess(state: reader.state, server: "s", deviceID: nil).actions.isEmpty)
    #expect(await Self.code { try await reader.request("action", stop) } == "forbidden")
    #expect(await Self.code { try await reader.request("control.begin", begin) } == "forbidden")

    let controlling = try await Self.pair(try await server.payload(control: true), store: InMemoryPairedServerStore())
    let controller = await Self.connect(controlling, endpoint: controlling.endpoint)
    defer { controller.stop() }
    guard case .open(let hello) = controller.state, let deviceID = hello.device?.id else {
      Issue.record("the control pairing ended \(controller.state)")
      return
    }
    #expect(PairedAccess(state: controller.state, server: "s", deviceID: deviceID).actions == ["reload", "stop"])
    let stopped = try await controller.request("action", stop)
    #expect(stopped.objectValue?["action"] == .string("stop"))
    #expect(stopped.objectValue?["workspace"] == .string(workspace))

    try await server.grant(deviceID, "--read")
    #expect(await Self.code { try await controller.request("action", stop) } == "forbidden")
  }

  @Test func onlyAMatchingFingerprintReachesMessage3AndAPairingPastItIsKept() async throws {
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

    do {
      _ = try await Self.pair(try Self.payload(port: port, token: token, fingerprint: fingerprint), store: store)
      Issue.record("the responder never answers hello, yet the pairing completed")
    } catch let error as ServerError {
      #expect(error.code == "pairing-unconfirmed")
    }
    #expect(try await responder.line(3) == ["message3": .bool(true), "payload": .string(#"{"name":"Interop Mac"}"#)])
    #expect(try store.pairings().map(\.id) == [fingerprint])
  }

  @Test func aPairingTheServerRefusesToRecordLeavesNoKeyBehind() async throws {
    let server = try await RunningServer()
    defer { server.stop() }
    let payload = try await server.payload()
    let winner = InMemoryPairedServerStore()
    let pairing = try await Self.pair(payload, store: winner)

    let loser = InMemoryPairedServerStore()
    await #expect(throws: NoiseClientTransport.refusal("unknown-secret")) {
      _ = try await Self.pair(payload, store: loser)
    }
    #expect(try loser.pairings().isEmpty)
    #expect(try winner.pairings() == [pairing])
  }

  @Test func twoPairingsWithTheSameServerNeverForgetTheWinnersKey() async throws {
    let server = try await RunningServer()
    defer { server.stop() }
    let payload = try await server.payload()
    let store = InMemoryPairedServerStore()
    async let first = Self.outcome(payload, store)
    async let second = Self.outcome(payload, store)
    var winners: [PairedServer] = []
    var errors: [ServerError] = []
    for result in [await first, await second] {
      switch result {
      case .success(let pairing): winners.append(pairing)
      case .failure(let error): errors.append(error)
      }
    }
    #expect(winners.count == 1)
    #expect(errors.map(\.code) == ["pairing-in-progress"])
    #expect(try store.pairings() == winners)
  }

  @Test func aServerThatNeverAnswersHelloEndsThePairingAtTheTimeoutAndKeepsIt() async throws {
    let runtime = try #require(Self.runtime)
    let token = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    let responder = try Child([Self.responder, runtime, token, "hold"], environment: ["PATH": "/usr/bin:/bin"])
    defer { responder.stop() }
    let listening = try await responder.line(0)
    let port = try #require(listening["port"]?.number.flatMap(ServerProtocol.exactInteger))
    let fingerprint = try #require(listening["fingerprint"]?.string)
    let payload = try Self.payload(port: port, token: token, fingerprint: fingerprint)

    let store = InMemoryPairedServerStore()
    let started = Date()
    do {
      _ = try await NoisePairing.pair(
        payload, store: store, deviceName: "Interop Mac", clientName: "Stim Desktop test", clientVersion: "1", timeout: 1)
      Issue.record("the pairing completed without a hello reply")
    } catch let error as ServerError {
      #expect(error.code == "pairing-unconfirmed")
      #expect(error.message.contains("did not answer in time"))
    }
    #expect(Date().timeIntervalSince(started) < 8)
    #expect(try store.pairings().map(\.id) == [fingerprint])

    let cancelled = InMemoryPairedServerStore()
    let other = try Self.payload(port: port, token: token, fingerprint: fingerprint)
    let task = Task {
      try await NoisePairing.pair(
        other, store: cancelled, deviceName: "Interop Mac", clientName: "Stim Desktop test", clientVersion: "1",
        timeout: 60)
    }
    _ = try await responder.line(2)
    task.cancel()
    do {
      _ = try await task.value
      Issue.record("a cancelled pairing completed")
    } catch let error as ServerError {
      #expect(error.code == "pairing-unconfirmed")
    }
    #expect(try cancelled.pairings().map(\.id) == [fingerprint])
  }
}
