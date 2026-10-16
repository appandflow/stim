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

  @Test func reloadPreservesProgressJSONAndTypedRefusalsWithoutCLI() async throws {
    let key = DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key), features: ["desktop-reload"]))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim-test"], override: "/does-not-exist/stim")
    for exit in [0, 1] {
      var lines: [OutputLine] = []
      let task = Task {
        try await runServerReload(
          StimCommand(["reload", "web", "--json"], cwd: "/selected"), cli: cli,
          connection: (client, "/tmp/stim-test"), onLine: { lines.append($0) })
      }
      await settle()
      #expect(socket.sent.last?["params"] == .object(["cwd": .string("/selected"), "platform": .string("web")]))
      socket.answer("desktop.reload.subscribe", .object(["subscription": .string("s\(exit)")]))
      socket.reply([
        "event": .string("desktop-reload-progress"), "subscription": .string("s\(exit)"),
        "stream": .string("stderr"), "message": .string("Inspecting app\n"),
      ])
      let json = exit == 0 ? #"{"platform":"web","strategy":"cdp"}"# : #"{"code":"STIM_RELOAD_STOPPED","message":"No app"}"#
      let message = exit == 0 ? "Reload requested. Completion is not observed." : "STIM_RELOAD_STOPPED: No app"
      socket.reply([
        "event": .string("desktop-reload-ended"), "subscription": .string("s\(exit)"), "exitCode": .number(Double(exit)),
        "stdout": .string(json), "message": .string(message),
      ])
      let result = try await task.value
      #expect(result.exitStatus == Int32(exit) && String(decoding: result.stdout, as: UTF8.self) == json)
      #expect(lines.prefix(2) == [OutputLine(.stderr, "Inspecting app"), OutputLine(.stdout, json)])
      #expect(lines.contains(OutputLine(.stderr, message)) == (exit != 0))
      await settle()
      socket.answer("unsubscribe", .object([:]))
    }
    for arguments in [["reload", "--json", "web"], ["reload", "--json", "--json"], ["reload", "macos"], ["stop"]] {
      do {
        _ = try await runServerReload(StimCommand(arguments, cwd: "/selected"), cli: cli, connection: (client, "/tmp/stim-test"))
        Issue.record("Unsupported reload command must fail before subscribing")
      } catch let error as ServerError {
        #expect(error.code == "bad-request")
      }
    }
  }

  @Test func startPreservesProgressJSONAndTypedRefusalsWithoutCLI() async throws {
    let key = DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key), features: ["desktop-start"]))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim-test"], override: "/does-not-exist/stim")
    for exit in [0, 1] {
      var lines: [OutputLine] = []
      let task = Task {
        try await runServerStart(
          StimCommand(["start", "--remote", "--reset-cache", "--wait", "90", "--json"], cwd: "/selected"), cli: cli,
          connection: (client, "/tmp/stim-test"), onLine: { lines.append($0) })
      }
      await settle()
      #expect(
        socket.sent.last?["params"]
          == .object(["cwd": .string("/selected"), "remote": .bool(true), "resetCache": .bool(true), "waitSeconds": .number(90)]))
      socket.answer("desktop.start.subscribe", .object(["subscription": .string("s\(exit)")]))
      socket.reply([
        "event": .string("desktop-start-progress"), "subscription": .string("s\(exit)"),
        "stream": .string("stdout"), "message": .string("Starting dev server\n"),
      ])
      socket.reply([
        "event": .string("desktop-start-progress"), "subscription": .string("s\(exit)"),
        "stream": .string("stderr"), "message": .string("Inspecting app\n"),
      ])
      let json = exit == 0 ? #"{"port":8081,"alreadyRunning":false}"# : #"{"code":"STIM_METRO_TIMEOUT","message":"No app"}"#
      let message = exit == 0 ? "Dev server ready on port 8081." : "STIM_METRO_TIMEOUT: No app"
      socket.reply([
        "event": .string("desktop-start-ended"), "subscription": .string("s\(exit)"), "exitCode": .number(Double(exit)),
        "stdout": .string(json), "message": .string(message),
      ])
      let result = try await task.value
      #expect(result.exitStatus == Int32(exit) && String(decoding: result.stdout, as: UTF8.self) == json)
      #expect(
        lines.prefix(3)
          == [OutputLine(.stderr, "Starting dev server"), OutputLine(.stderr, "Inspecting app"), OutputLine(.stdout, json)])
      #expect(lines.filter { $0.channel == .stdout }.map(\.text).joined(separator: "\n") == json)
      #expect(lines.contains(OutputLine(.stderr, message)) == (exit != 0))
      await settle()
      socket.answer("unsubscribe", .object([:]))
    }
    for arguments in [
      ["start", "--json", "--json"], ["start", "--remote", "--remote"], ["start", "--wait"], ["start", "--wait", "0"],
      ["start", "--wait", "1.5"], ["start", "--wait", "9007199254740992"], ["start", "ios"], ["stop"],
    ] {
      do {
        _ = try await runServerStart(StimCommand(arguments, cwd: "/selected"), cli: cli, connection: (client, "/tmp/stim-test"))
        Issue.record("Unsupported start command must fail before subscribing")
      } catch let error as ServerError {
        #expect(error.code == "bad-request")
      }
    }
  }

  @Test func settingsPreserveMaskedResultsAndTypedRefusalsWithoutCLI() async throws {
    let key = DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key), features: ["desktop-settings-write"]))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim-test"], override: "/does-not-exist/stim")
    let task = Task {
      try await writeServerSetting(
        "android.keystorePassword", value: "private-value", scope: .workspace, cwd: "/selected",
        cli: cli, connection: (client, "/tmp/stim-test"))
    }
    await settle()
    #expect(
      socket.sent.last?["params"]
        == .object([
          "cwd": .string("/selected"), "key": .string("android.keystorePassword"), "value": .string("private-value"),
          "scope": .string("workspace"), "action": .string("set"),
        ]))
    let payload: JSONValue = .object([
      "setting": .object([
        "key": .string("android.keystorePassword"), "value": .string("********"), "origin": .string("workspace"),
        "layers": .object(["workspace": .string("********")]), "sensitive": .bool(true),
      ])
    ])
    socket.answer("desktop.settings.write", payload)
    let written = try await task.value
    guard case .written(let entry) = written.result else {
      Issue.record("A successful settings write must return the setting")
      return
    }
    #expect(entry.value == .string("********") && written.payload == payload)

    let unset = Task {
      try await writeServerSetting(
        "ios.runtime", value: nil, scope: .workspace, cwd: "/selected", cli: cli, connection: (client, "/tmp/stim-test"))
    }
    await settle()
    #expect(
      socket.sent.last?["params"]
        == .object([
          "cwd": .string("/selected"), "key": .string("ios.runtime"), "scope": .string("workspace"), "action": .string("unset"),
        ]))
    socket.answer(
      "desktop.settings.write",
      .object([
        "code": .string("STIM_NO_PROJECT"), "message": .string("No app"), "remedy": .string("Choose an app"),
      ]))
    guard case .refused(let refusal) = try await unset.value.result else {
      Issue.record("A typed settings refusal must remain a refusal")
      return
    }
    #expect(refusal.code == "STIM_NO_PROJECT" && refusal.message == "No app" && refusal.remedy == "Choose an app")
  }

  @Test(arguments: ["home", "authority", "feature"])
  func settingsRefuseWrongHomeMissingAuthorityAndOldServers(reason: String) async throws {
    let key = reason == "authority" ? nil : DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer(
      "hello",
      hello(
        key.map { bootstrapChallenge($0) }, features: reason == "feature" ? [] : ["desktop-settings-write"]))
    await settle()
    if key != nil {
      socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
      await settle()
    }
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim-test"], override: "/does-not-exist/stim")
    do {
      _ = try await writeServerSetting(
        "ios.runtime", value: "26.4", scope: .workspace, cwd: "/selected", cli: cli,
        connection: (client, reason == "home" ? "/another-home" : "/tmp/stim-test"))
      Issue.record("Settings must refuse this connection")
    } catch let error as ServerError {
      #expect(error.code == (reason == "feature" ? "unsupported" : "not-connected"))
    }
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.settings.write") })
  }

  @Test func cancellingSettingsKeepsTheSharedConnectionAndIgnoresTheLateReply() async throws {
    let key = DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key), features: ["desktop-settings-write"]))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim-test"], override: "/does-not-exist/stim")
    let task = Task {
      try await writeServerSetting(
        "ios.runtime", value: nil, scope: .workspace, cwd: "/selected", cli: cli, connection: (client, "/tmp/stim-test"))
    }
    await settle()
    #expect(socket.sent.last?["method"] == .string("desktop.settings.write"))
    task.cancel()
    do {
      _ = try await task.value
      Issue.record("Cancelled settings must finish the local await")
    } catch is CancellationError {}
    socket.answer("desktop.settings.write", .object([:]))
    await settle()
    #expect(client.isOpen && !socket.closed)
    #expect(socket.sent.filter { $0["method"] == .string("desktop.settings.write") }.count == 1)
  }

  @Test(arguments: ["settings", "reload", "start"])
  func mutationsDoNotReplayAfterTheConnectionDropsAndReconnects(action: String) async throws {
    let feature = action == "settings" ? "desktop-settings-write" : "desktop-\(action)"
    let method = action == "settings" ? "desktop.settings.write" : "desktop.\(action).subscribe"
    let key = DesktopBootstrapKey()
    var sockets: [FakeTransport] = []
    var reconnect: (@MainActor () -> Void)?
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim-test/server/local.sock"), clientName: "Stim Desktop", clientVersion: "1",
      serverPort: 7787, bootstrap: { key },
      transport: { _, event in
        let socket = FakeTransport(onEvent: event)
        sockets.append(socket)
        return socket
      },
      scheduler: { _, work in
        reconnect = work
        return {}
      })
    client.start()
    defer { client.stop() }
    await settle()
    let first = try #require(sockets.first)
    first.answer("hello", hello(bootstrapChallenge(key), features: [feature]))
    await settle()
    first.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim-test"], override: "/does-not-exist/stim")
    let task = Task {
      if action == "settings" {
        _ = try await writeServerSetting(
          "ios.runtime", value: "26.4", scope: .workspace, cwd: "/selected", cli: cli, connection: (client, "/tmp/stim-test"))
      } else if action == "start" {
        _ = try await runServerStart(StimCommand([action], cwd: "/selected"), cli: cli, connection: (client, "/tmp/stim-test"))
      } else {
        _ = try await runServerReload(
          StimCommand(["reload"], cwd: "/selected"), cli: cli, connection: (client, "/tmp/stim-test"))
      }
    }
    await settle()
    #expect(first.sent.last?["method"] == .string(method))
    first.onEvent(.closed("Connection lost."))
    await #expect(throws: ServerError.self) { try await task.value }
    let resume = try #require(reconnect)
    resume()
    await settle()
    let second = try #require(sockets.last)
    #expect(second !== first)
    second.answer("hello", hello(bootstrapChallenge(key), features: [feature]))
    await settle()
    second.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    #expect(client.isOpen && client.hasDesktopAuthority)
    #expect(!second.sent.contains { $0["method"] == .string(method) })
  }

  @Test(arguments: ["stop", "reload"])
  func cancellingAnActionUnsubscribesWithoutDisconnectingTheSharedClient(action: String) async throws {
    let key = DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key), features: ["desktop-\(action)"]))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim-test"], override: "/does-not-exist/stim")
    let task = Task {
      if action == "stop" {
        _ = try await runServerStop(StimCommand([action], cwd: "/selected"), cli: cli, connection: (client, "/tmp/stim-test"))
      } else if action == "start" {
        _ = try await runServerStart(StimCommand([action], cwd: "/selected"), cli: cli, connection: (client, "/tmp/stim-test"))
      } else {
        _ = try await runServerReload(StimCommand([action], cwd: "/selected"), cli: cli, connection: (client, "/tmp/stim-test"))
      }
    }
    await settle()
    #expect(socket.sent.last?["params"] == .object(["cwd": .string("/selected")]))
    socket.answer("desktop.\(action).subscribe", .object(["subscription": .string("s1")]))
    task.cancel()
    do {
      _ = try await task.value
      Issue.record("Cancelled action must finish its local await")
    } catch is CancellationError {}
    await settle()
    #expect(client.isOpen && !socket.closed)
    #expect(socket.sent.last?["method"] == .string("unsubscribe"))
    #expect(socket.sent.last?["params"] == .object(["subscription": .string("s1")]))
    socket.answer("unsubscribe", .object([:]))
  }

  @Test(arguments: [false, true], [false, true])
  func startupCancellationWaitsForCleanupAcknowledgement(accepted: Bool, retained: Bool) async throws {
    let key = DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key), features: ["desktop-start"]))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim-test"], override: "/does-not-exist/stim")
    var returned = false
    let task = Task {
      defer { returned = true }
      _ = try await runServerStart(StimCommand(["start"], cwd: "/selected"), cli: cli, connection: (client, "/tmp/stim-test"))
    }
    await settle()
    if accepted { socket.answer("desktop.start.subscribe", .object(["subscription": .string("s1")])) }
    task.cancel()
    await settle()
    #expect(!returned)
    if !accepted { socket.answer("desktop.start.subscribe", .object(["subscription": .string("s1")])) }
    await settle()
    #expect(socket.sent.last?["method"] == .string("unsubscribe"))
    #expect(!returned)
    if retained {
      let request = try #require(socket.sent.last)
      socket.reply([
        "id": try #require(request["id"]),
        "error": .object([
          "code": .string("action-failed"), "message": .string("STIM_CLAIM_UNAVAILABLE: Recover /exact/claim"),
        ]),
      ])
      do {
        try await task.value
        Issue.record("Retained startup must report its recovery refusal")
      } catch let error as ServerError {
        #expect(error.message == "STIM_CLAIM_UNAVAILABLE: Recover /exact/claim")
      }
    } else {
      socket.answer("unsubscribe", .object([:]))
      await #expect(throws: CancellationError.self) { try await task.value }
    }
    #expect(returned && client.isOpen && !socket.closed)
  }

  @Test(arguments: [false, true])
  func startupCancellationPreservesATerminalRecoveryAlreadyDispatched(beforeCancel: Bool) async throws {
    let key = DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key), features: ["desktop-start"]))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim-test"], override: "/does-not-exist/stim")
    let task = Task {
      try await runServerStart(
        StimCommand(["start", "--json"], cwd: "/selected"), cli: cli, connection: (client, "/tmp/stim-test"))
    }
    await settle()
    socket.answer("desktop.start.subscribe", .object(["subscription": .string("s1")]))
    let failure: [String: JSONValue] = [
      "event": .string("desktop-start-ended"), "subscription": .string("s1"), "exitCode": .number(1),
      "stdout": .string(#"{"code":"STIM_CLAIM_UNAVAILABLE","remedy":"Recover /exact/claim"}"#),
      "message": .string("STIM_CLAIM_UNAVAILABLE: Recover /exact/claim"),
    ]
    if beforeCancel { socket.reply(failure) }
    task.cancel()
    await settle()
    #expect(socket.sent.last?["method"] == .string("unsubscribe"))
    if !beforeCancel { socket.reply(failure) }
    let request = try #require(socket.sent.last)
    socket.reply([
      "id": try #require(request["id"]),
      "error": .object(["code": .string("unknown-subscription"), "message": .string("Already finished")]),
    ])
    let result = try await task.value
    #expect(result.exitStatus == 1 && result.message == "STIM_CLAIM_UNAVAILABLE: Recover /exact/claim")
    #expect(String(decoding: result.stdout, as: UTF8.self).contains("Recover /exact/claim"))
    #expect(client.isOpen && !socket.closed)
  }

  @Test(arguments: ["home", "authority", "feature"], ["stop", "reload", "start"])
  func actionsRefuseWrongHomeMissingAuthorityAndOldServers(reason: String, action: String) async throws {
    let key = reason == "authority" ? nil : DesktopBootstrapKey()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(key.map { bootstrapChallenge($0) }, features: reason == "feature" ? [] : ["desktop-\(action)"]))
    await settle()
    if key != nil {
      socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
      await settle()
    }
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim-test"], override: "/does-not-exist/stim")
    do {
      let connection = (client, reason == "home" ? "/another-home" : "/tmp/stim-test")
      if action == "stop" {
        _ = try await runServerStop(StimCommand([action], cwd: "/selected"), cli: cli, connection: connection)
      } else if action == "start" {
        _ = try await runServerStart(StimCommand([action], cwd: "/selected"), cli: cli, connection: connection)
      } else {
        _ = try await runServerReload(StimCommand([action], cwd: "/selected"), cli: cli, connection: connection)
      }
      Issue.record("Action must refuse this connection")
    } catch let error as ServerError {
      #expect(error.code == (reason == "feature" ? "unsupported" : "not-connected"))
    }
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.\(action).subscribe") })
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
