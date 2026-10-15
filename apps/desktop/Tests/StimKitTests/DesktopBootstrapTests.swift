import CryptoKit
import Foundation
import Testing

@testable import StimKit

private func bootstrapSignature(_ key: DesktopBootstrapKey, _ message: String) -> String {
  let encoded = String(decoding: key.input, as: UTF8.self).trimmingCharacters(in: .newlines)
  let data = Data(base64Encoded: encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "=")!
  return Data(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: SymmetricKey(data: data)))
    .base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

private func bootstrapChallenge(_ key: DesktopBootstrapKey, nonce: String = String(repeating: "A", count: 43))
  -> DesktopBootstrapChallenge
{
  DesktopBootstrapChallenge(nonce: nonce, proof: bootstrapSignature(key, "server:\(nonce)"))
}

@Suite struct DesktopBootstrapKeyTests {
  @Test func verifiesTheServerBeforeProducingTheSeparateClientProof() {
    let key = DesktopBootstrapKey()
    let challenge = bootstrapChallenge(key)
    #expect(key.clientProof(for: challenge) == bootstrapSignature(key, "client:\(challenge.nonce)"))
    #expect(key.clientProof(for: challenge) != challenge.proof)
    #expect(DesktopBootstrapKey().clientProof(for: challenge) == nil)
    #expect(
      key.clientProof(for: DesktopBootstrapChallenge(nonce: String(repeating: "B", count: 43), proof: challenge.proof)) == nil)
    #expect(
      key.clientProof(
        for: DesktopBootstrapChallenge(nonce: challenge.nonce, proof: bootstrapSignature(key, "client:\(challenge.nonce)")))
        == nil)
    #expect(key.clientProof(for: DesktopBootstrapChallenge(nonce: "invalid", proof: challenge.proof)) == nil)
  }

  @Test func theBundledChildReadsThePrivatePipeWithoutAnArgumentOrEnvironmentSecret() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("desktop-bootstrap-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let script = root.appendingPathComponent("child.pl")
    try #"""
    use Digest::SHA qw(hmac_sha256);
    use MIME::Base64 qw(decode_base64 encode_base64);
    my $key = <STDIN>; $key =~ s/\n\z//;
    die 'invalid input' unless length($key) == 43;
    die 'secret exposed' if index(join(' ', @ARGV, values %ENV), $key) >= 0;
    die 'missing marker' unless $ENV{STIM_DESKTOP_BOOTSTRAP_FD} eq '0';
    my $nonce = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    my $encoded = $key; $encoded =~ tr{-_}{+/};
    my $proof = encode_base64(hmac_sha256("server:$nonce", decode_base64($encoded . '=')), '');
    $proof =~ tr{+/}{-_}; $proof =~ s/=+$//;
    print '{"nonce":"' . $nonce . '","proof":"' . $proof . '"}' . "\n";
    """#.write(to: script, atomically: true, encoding: .utf8)
    let key = DesktopBootstrapKey()
    let cli = StimServerCLI(environment: [:], bundled: BundledServer(node: "/usr/bin/perl", script: script.path))
    let lines = LockedValue([OutputLine]())
    let exit = LockedValue<Int32?>(nil)
    let process = try cli.serve(
      bootstrap: key, onLine: { line in lines.withLock { $0.append(line) } }, onExit: { status in exit.withLock { $0 = status } })
    defer { if process.isRunning { process.terminate() } }
    for _ in 0..<500 {
      if exit.withLock({ $0 }) != nil { break }
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(exit.withLock { $0 } == 0)
    let output = lines.withLock { $0.filter { $0.channel == .stdout }.map(\.text).joined(separator: "\n") }
    let challenge = try JSONDecoder().decode(DesktopBootstrapChallenge.self, from: Data(output.utf8))
    #expect(key.clientProof(for: challenge) == bootstrapSignature(key, "client:\(challenge.nonce)"))
    let secret = String(decoding: key.input, as: UTF8.self).trimmingCharacters(in: .newlines)
    #expect(!output.contains(secret))
    #expect(!(process.arguments ?? []).contains(secret))
    #expect(!(process.environment ?? [:]).values.contains(secret))
  }

  @Test func anExternalOverrideCannotReceiveThePrivateKey() throws {
    let cli = StimServerCLI(environment: [:], override: "/bin/cat", bundled: nil)
    #expect(throws: ServerError(code: "forbidden", message: "Private Desktop bootstrap requires the bundled server.")) {
      try cli.serve(bootstrap: DesktopBootstrapKey(), onLine: { _ in }, onExit: { _ in })
    }
  }
}

@Suite @MainActor struct DesktopBootstrapClientTests {
  private func hello(_ challenge: DesktopBootstrapChallenge? = nil, port: Int = 7787, features: [String] = ["desktop-stop"])
    -> JSONValue
  {
    var fields: [String: JSONValue] = [
      "protocol": .number(2),
      "server": .object([
        "name": .string("Mac"), "version": .string("1"), "stim": .string("1"), "port": .number(Double(port)),
      ]),
      "capabilities": .array([.string("read"), .string("control")]),
      "device": .object(["id": .string("d1"), "name": .string("Stim Desktop")]),
      "features": .array(features.map(JSONValue.string)),
    ]
    if let challenge {
      fields["desktopBootstrap"] = .object(["nonce": .string(challenge.nonce), "proof": .string(challenge.proof)])
    }
    return .object(fields)
  }

  private func client(key: DesktopBootstrapKey?) async throws -> (ServerClient, FakeTransport) {
    var socket: FakeTransport?
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim-test/server/local.sock"), clientName: "Stim Desktop", clientVersion: "1",
      serverPort: 7787, bootstrap: { key },
      transport: { _, event in
        let next = FakeTransport(onEvent: event)
        socket = next
        return next
      },
      scheduler: { _, _ in {} })
    client.start()
    await settle()
    return (client, try #require(socket))
  }

  @Test func stopKeepsBackToBackProgressAndTheFlatSlotResult() async throws {
    let key = DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim-test"], override: "/does-not-exist/stim")
    var lines: [OutputLine] = []
    let task = Task {
      try await runServerStop(
        StimCommand(["stop", "--slot", "web", "--json"], cwd: "/selected"), cli: cli,
        connection: (client, "/tmp/stim-test"), onLine: { lines.append($0) })
    }
    await settle()
    #expect(socket.sent.last?["params"] == .object(["cwd": .string("/selected"), "slot": .string("web")]))
    socket.answer("desktop.stop.subscribe", .object(["subscription": .string("s1")]))
    socket.reply([
      "event": .string("desktop-stop-progress"), "subscription": .string("s1"),
      "stream": .string("stderr"), "message": .string("Closing Chrome\n"),
    ])
    socket.reply([
      "event": .string("desktop-stop-ended"), "subscription": .string("s1"), "exitCode": .number(0),
      "stdout": .string(#"{"stopped":true}"#), "message": .string("Stopped web."),
    ])
    let result = try await task.value
    #expect(result.exitStatus == 0)
    #expect(String(decoding: result.stdout, as: UTF8.self) == #"{"stopped":true}"#)
    #expect(lines == [OutputLine(.stderr, "Closing Chrome"), OutputLine(.stdout, #"{"stopped":true}"#)])
    await settle()
    socket.answer("unsubscribe", .object([:]))
  }

  @Test func cancellingAStopUnsubscribesWithoutDisconnectingTheSharedClient() async throws {
    let key = DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim-test"], override: "/does-not-exist/stim")
    let task = Task {
      try await runServerStop(StimCommand(["stop"], cwd: "/selected"), cli: cli, connection: (client, "/tmp/stim-test"))
    }
    await settle()
    #expect(socket.sent.last?["params"] == .object(["cwd": .string("/selected")]))
    socket.answer("desktop.stop.subscribe", .object(["subscription": .string("s1")]))
    task.cancel()
    do {
      _ = try await task.value
      Issue.record("Cancelled stop must finish its local await")
    } catch is CancellationError {}
    await settle()
    #expect(client.isOpen && !socket.closed)
    #expect(socket.sent.last?["method"] == .string("unsubscribe"))
    #expect(socket.sent.last?["params"] == .object(["subscription": .string("s1")]))
    socket.answer("unsubscribe", .object([:]))
  }

  @Test(arguments: ["home", "authority", "feature"])
  func stopRefusesWrongHomeMissingAuthorityAndOldServers(reason: String) async throws {
    let key = reason == "authority" ? nil : DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(key.map { bootstrapChallenge($0) }, features: reason == "feature" ? [] : ["desktop-stop"]))
    await settle()
    if key != nil {
      socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
      await settle()
    }
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim-test"], override: "/does-not-exist/stim")
    do {
      _ = try await runServerStop(
        StimCommand(["stop"], cwd: "/selected"), cli: cli,
        connection: (client, reason == "home" ? "/another-home" : "/tmp/stim-test"))
      Issue.record("Stop must refuse this connection")
    } catch let error as ServerError {
      #expect(error.code == (reason == "feature" ? "unsupported" : "not-connected"))
    }
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.stop.subscribe") })
  }

  @Test func authorityRequiresBothTheChildProofAndTheServerAcceptanceAndEndsOnDisconnect() async throws {
    let key = DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    let challenge = bootstrapChallenge(key)
    socket.answer("hello", hello(challenge))
    await settle()
    #expect(!client.isOpen && !client.hasDesktopAuthority)
    let request = try #require(socket.sent.last { $0["method"] == .string("desktop.authenticate") })
    #expect(request["params"] == .object(["proof": .string(bootstrapSignature(key, "client:\(challenge.nonce)"))]))
    let secret = String(decoding: key.input, as: UTF8.self).trimmingCharacters(in: .newlines)
    #expect(!String(decoding: try JSONEncoder().encode(socket.sent), as: UTF8.self).contains(secret))
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    #expect(client.isOpen && client.hasDesktopAuthority)
    socket.onEvent(.closed("revoked"))
    #expect(!client.isOpen && !client.hasDesktopAuthority)
  }

  @Test func aDifferentChildCannotExtractTheParentProof() async throws {
    let (client, socket) = try await client(key: DesktopBootstrapKey())
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(DesktopBootstrapKey())))
    await settle()
    #expect(!client.isOpen && !client.hasDesktopAuthority && socket.closed)
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.authenticate") })
  }

  @Test func disconnectWhileAuthenticatingCannotRestoreAuthorityWithALateReply() async throws {
    let key = DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.onEvent(.closed("interrupted"))
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    #expect(!client.isOpen && !client.hasDesktopAuthority)
  }

  @Test(arguments: [false, true]) func oldOrAdoptedServersStayConnectedWithoutPrivateAuthority(hasKey: Bool) async throws {
    let (client, socket) = try await client(key: hasKey ? DesktopBootstrapKey() : nil)
    defer { client.stop() }
    socket.answer("hello", hello())
    await settle()
    #expect(client.isOpen && !client.hasDesktopAuthority)
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.authenticate") })
    let request = try #require(socket.sent.first)
    if case .object(let params)? = request["params"] {
      #expect(params["desktopBootstrap"] == (hasKey ? .bool(true) : nil))
      #expect(params["auth"] == nil)
    } else {
      Issue.record("hello must carry params")
    }
  }

  @Test func refusesAnotherServersSocketBeforeSendingAnyProof() async throws {
    let key = DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key), port: 9999))
    await settle()
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.authenticate") })
    #expect(!client.isOpen && !client.hasDesktopAuthority)
    guard case .refused(let error) = client.state else {
      Issue.record("expected a refusal, got \(client.state)")
      return
    }
    #expect(error.code == "other-server")
  }
}
