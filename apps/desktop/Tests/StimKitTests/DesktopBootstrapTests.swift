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
    let key = DesktopBootstrapKey.random()
    let challenge = bootstrapChallenge(key)
    #expect(key.clientProof(for: challenge) == bootstrapSignature(key, "client:\(challenge.nonce)"))
    #expect(key.clientProof(for: challenge) != challenge.proof)
    #expect(DesktopBootstrapKey.random().clientProof(for: challenge) == nil)
    #expect(
      key.clientProof(for: DesktopBootstrapChallenge(nonce: String(repeating: "B", count: 43), proof: challenge.proof)) == nil)
    #expect(
      key.clientProof(
        for: DesktopBootstrapChallenge(nonce: challenge.nonce, proof: bootstrapSignature(key, "client:\(challenge.nonce)")))
        == nil)
    #expect(key.clientProof(for: DesktopBootstrapChallenge(nonce: "invalid", proof: challenge.proof)) == nil)
  }

  @Test func readsOnlyAPrivateKeyFileThisUserOwns() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("desktop-key-\(UUID().uuidString)")
    let run = home.appendingPathComponent("run")
    try FileManager.default.createDirectory(at: run, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: home) }
    let file = run.appendingPathComponent("desktop.key")
    #expect(DesktopBootstrapKey.read(stimHome: home.path) == nil)
    let key = DesktopBootstrapKey.random()
    try key.input.write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file.path)
    #expect(DesktopBootstrapKey.read(stimHome: home.path) == nil)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    let read = try #require(DesktopBootstrapKey.read(stimHome: home.path))
    let challenge = bootstrapChallenge(key)
    #expect(read.clientProof(for: challenge) == key.clientProof(for: challenge))
    try FileManager.default.removeItem(at: file)
    try FileManager.default.createSymbolicLink(at: file, withDestinationURL: home.appendingPathComponent("elsewhere"))
    try key.input.write(to: home.appendingPathComponent("elsewhere"))
    #expect(DesktopBootstrapKey.read(stimHome: home.path) == nil)
    try FileManager.default.removeItem(at: file)
    try Data("short\n".utf8).write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    #expect(DesktopBootstrapKey.read(stimHome: home.path) == nil)
  }
}

@Suite @MainActor struct DesktopBootstrapClientTests {
  private func hello(_ challenge: DesktopBootstrapChallenge? = nil, port: Int = 7787, owner: String = "desktop")
    -> JSONValue
  {
    var fields: [String: JSONValue] = [
      "protocol": .number(2), "desktopApi": .number(1),
      "server": .object([
        "name": .string("Mac"), "version": .string("1"), "stim": .string("1"), "port": .number(Double(port)),
      ]),
      "capabilities": .array([.string("read"), .string("control")]),
      "device": .object(["id": .string("d1"), "name": .string("Stim Desktop")]),
      "host": .object(["owner": .string(owner), "capabilities": .array([])]),
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
      bootstrap: { key },
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
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    var lines: [OutputLine] = []
    let task = Task {
      try await runServerStop(
        StimCommand(["stop", "--slot", "web", "--json"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
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
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    for exit in [0, 1] {
      var lines: [OutputLine] = []
      let task = Task {
        try await runServerReload(
          StimCommand(["reload", "web", "--json"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
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
        _ = try await runServerReload(
          StimCommand(arguments, cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
        Issue.record("Unsupported reload command must fail before subscribing")
      } catch let error as ServerError {
        #expect(error.code == "bad-request")
      }
    }
  }

  @Test func startPreservesProgressJSONAndTypedRefusalsWithoutCLI() async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    for exit in [0, 1] {
      var lines: [OutputLine] = []
      let task = Task {
        try await runServerStart(
          StimCommand(["start", "--remote", "--reset-cache", "--wait", "90", "--json"], cwd: "/selected"),
          stimHome: StimHome.path(environment: environment),
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
        _ = try await runServerStart(
          StimCommand(arguments, cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
        Issue.record("Unsupported start command must fail before subscribing")
      } catch let error as ServerError {
        #expect(error.code == "bad-request")
      }
    }
  }

  @Test(arguments: [
    (
      ["ios", "--slot", "fold", "--remote", "mini", "--json"],
      ["platform": JSONValue.string("ios"), "slot": .string("fold"), "remote": .string("mini")]
    ),
    (
      ["android", "--remote-build", "mini", "--no-build-cache", "--json"],
      ["platform": JSONValue.string("android"), "remoteBuild": .string("mini"), "buildCache": .bool(false)]
    ),
    (["macos", "--remote", "mini", "--json"], ["platform": JSONValue.string("macos"), "remote": .string("mini")]),
    (["web", "--headed", "--json"], ["platform": JSONValue.string("web"), "headed": .bool(true)]),
  ])
  func platformRunsKeepSelectorsProgressFlatFactsAndRefusals(arguments: [String], options: [String: JSONValue]) async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    let facts = JSONValue.object(["launched": .string("unverified"), "builtOn": .string("mini")])
    for exit in [0, 1] {
      var lines: [OutputLine] = []
      let task = Task {
        try await runServerPlatform(
          StimCommand(arguments, cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"),
          onLine: { lines.append($0) }
        )
      }
      await settle()
      #expect(socket.sent.last?["params"] == .object(["cwd": .string("/selected"), "options": .object(options)]))
      socket.answer("desktop.run.subscribe", .object(["subscription": .string("r\(exit)")]))
      socket.reply([
        "event": .string("desktop-run-progress"), "subscription": .string("r\(exit)"),
        "stream": .string("stdout"), "message": .string("Inspecting app\nBuilding app\n"),
      ])
      let refusal = JSONValue.object([
        "code": .string("STIM_CLAIM_UNAVAILABLE"), "message": .string("Recover /exact/claim"),
        "remedy": .string("Check ownership"),
      ])
      let output = exit == 0 ? JSONValue.object(["platform": try #require(options["platform"]), "facts": facts]) : refusal
      let message = exit == 0 ? "Run completed." : "STIM_CLAIM_UNAVAILABLE: Recover /exact/claim. Check ownership."
      socket.reply([
        "event": .string("desktop-run-ended"), "subscription": .string("r\(exit)"), "exitCode": .number(Double(exit)),
        "stdout": .string(String(decoding: try JSONEncoder().encode(output), as: UTF8.self)), "message": .string(message),
      ])
      let result = try await task.value
      #expect(result.exitStatus == Int32(exit))
      #expect(try JSONDecoder().decode(JSONValue.self, from: result.stdout) == (exit == 0 ? facts : refusal))
      #expect(lines.prefix(2) == [OutputLine(.stderr, "Inspecting app"), OutputLine(.stderr, "Building app")])
      let stdout = lines.filter { $0.channel == .stdout }.map(\.text).joined(separator: "\n")
      #expect(try JSONDecoder().decode(JSONValue.self, from: Data(stdout.utf8)) == (exit == 0 ? facts : refusal))
      #expect(lines.contains(OutputLine(.stderr, message)) == (exit != 0))
      await settle()
      socket.answer("unsubscribe", .object([:]))
    }
  }

  @Test(arguments: [
    (["gc", "--json"], "desktop.gc.subscribe", ["dryRun": JSONValue.bool(false)]),
    (["gc", "--dry-run", "--json"], "desktop.gc.subscribe", ["dryRun": .bool(true)]),
    (["gc"], "desktop.gc.subscribe", ["dryRun": .bool(false)]),
    (
      ["gc", "--pressure", "critical", "--json"], "desktop.gc.subscribe",
      ["dryRun": .bool(false), "pressure": .string("critical")]
    ),
    (
      GcItem.archive(id: "history", part: nil).arguments, "desktop.gc.item.subscribe",
      ["item": .object(["kind": .string("archive"), "id": .string("history")])]
    ),
    (
      GcItem.archive(id: "history", part: .agentActions).arguments, "desktop.gc.item.subscribe",
      ["item": .object(["kind": .string("archive"), "id": .string("history"), "part": .string("agentActions")])]
    ),
    (
      GcItem.cache(dir: "/s/build-cache").arguments, "desktop.gc.item.subscribe",
      ["item": .object(["kind": .string("cache"), "dir": .string("/s/build-cache")])]
    ),
    (GcItem.workspaceOutputs.arguments, "desktop.gc.item.subscribe", ["item": .object(["kind": .string("workspace-outputs")])]),
  ])
  func cleanupKeepsOptionsOrderedProgressAndPartialFailureReports(
    arguments: [String], method: String, options: [String: JSONValue]
  )
    async throws
  {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    for exit in [0, 1] {
      var lines: [OutputLine] = []
      let task = Task {
        try await runServerGc(
          StimCommand(arguments, cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"),
          onLine: { lines.append($0) }
        )
      }
      await settle()
      #expect(socket.sent.last?["method"] == .string(method))
      #expect(socket.sent.last?["params"] == .object(options.merging(["cwd": .string("/selected")]) { _, selected in selected }))
      socket.answer(method, .object(["subscription": .string("g\(exit)")]))
      socket.reply([
        "event": .string("desktop-gc-progress"), "subscription": .string("g\(exit)"),
        "stream": .string("stdout"), "message": .string("Inspecting cache\nCleaning cache\n"),
      ])
      let report = JSONValue.object([
        "mode": .string("delete"), "sections": .object([:]), "failures": .number(Double(exit)),
        "results": .array([
          .object(["kind": .string("cache"), "status": .string(exit == 0 ? "done" : "failed"), "label": .string("fixture")])
        ]),
      ])
      socket.reply([
        "event": .string("desktop-gc-ended"), "subscription": .string("g\(exit)"), "exitCode": .number(Double(exit)),
        "stdout": .string(String(decoding: try JSONEncoder().encode(report), as: UTF8.self)),
        "message": .string("Cleanup finished."),
      ])
      let result = try await task.value
      #expect(result.exitStatus == Int32(exit))
      #expect(try JSONDecoder().decode(JSONValue.self, from: result.stdout) == report)
      let json = arguments.contains("--json")
      let progress: OutputChannel = json ? .stderr : .stdout
      #expect(lines.prefix(2) == [OutputLine(progress, "Inspecting cache"), OutputLine(progress, "Cleaning cache")])
      let stdout = lines.filter { $0.channel == .stdout }.map(\.text).joined(separator: "\n")
      if json {
        #expect(try JSONDecoder().decode(JSONValue.self, from: Data(stdout.utf8)) == report)
      } else {
        #expect(stdout == "Inspecting cache\nCleaning cache" + (exit == 0 ? "\nCleanup finished." : ""))
      }
      #expect(lines.contains(OutputLine(.stderr, "Cleanup finished.")) == (exit != 0))
      await settle()
      socket.answer("unsubscribe", .object([:]))
    }
  }

  @Test func cleanupRefusesMalformedOptionsBeforeDispatch() async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    for invalid in [
      ["gc", "--pressure"], ["gc", "--pressure", "--json"], ["gc", "--pressure", "extreme"], ["gc", "--json", "--json"],
      ["gc", "--delete"], ["gc", "--cache", "x"], ["gc", "--idle", "30m"], ["gc", "--reclaim"],
    ] {
      do {
        _ = try await runServerGc(
          StimCommand(invalid, cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
        Issue.record("Malformed cleanup selectors must fail before subscribing")
      } catch let error as ServerError { #expect(error.code == "bad-request") }
    }
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.gc.subscribe") })
  }

  @Test(arguments: [
    (["worktree", "remove"], [String: JSONValue](), false, 0),
    (["worktree", "remove", "/target"], ["target": .string("/target")], true, 0),
    (["worktree", "remove", "/target", "--force"], ["target": .string("/target"), "force": .bool(true)], true, 1),
    (["worktree", "remove", "--force", "/target"], ["target": .string("/target"), "force": .bool(true)], true, 0),
  ])
  func removalPreservesSourceCleanupPartialFailureAndOrderedProgress(
    arguments: [String], options: [String: JSONValue], removed: Bool, exit: Int
  ) async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    var lines: [OutputLine] = []
    let task = Task {
      try await runServerWorktreeRemove(
        StimCommand(arguments, cwd: "/selected"), stimHome: StimHome.path(environment: environment),
        connection: (client, "/tmp/stim-test"),
        onLine: { lines.append($0) })
    }
    await settle()
    #expect(socket.sent.last?["params"] == .object(options.merging(["cwd": .string("/selected")]) { _, selected in selected }))
    socket.answer("desktop.worktree.remove.subscribe", .object(["subscription": .string("r1")]))
    socket.reply([
      "event": .string("desktop-worktree-remove-progress"), "subscription": .string("r1"),
      "stream": .string("stderr"), "message": .string("Stopping workspace\nRemoving checkout\n"),
    ])
    let payload = JSONValue.object(["removed": .bool(removed), "exitCode": .number(Double(exit))])
    socket.reply([
      "event": .string("desktop-worktree-remove-ended"), "subscription": .string("r1"), "exitCode": .number(Double(exit)),
      "stdout": .string(String(decoding: try JSONEncoder().encode(payload), as: UTF8.self)),
      "message": .string("Cleanup finished"),
    ])
    let result = try await task.value
    #expect(result.exitStatus == Int32(exit))
    #expect(result.message == (exit == 0 ? "Cleanup finished" : "Stopping workspace\nRemoving checkout\nCleanup finished"))
    #expect(try JSONDecoder().decode(JSONValue.self, from: result.stdout) == payload)
    #expect(lines.prefix(2) == [OutputLine(.stderr, "Stopping workspace"), OutputLine(.stderr, "Removing checkout")])
    #expect(!lines.contains { $0.channel == .stdout })
    await settle()
    socket.answer("unsubscribe", .object([:]))
  }

  @Test func removalRejectsMalformedSelectorsAndSuccessfulResults() async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    for invalid in [
      ["worktree", "remove", "relative"], ["worktree", "remove", "--json"],
      ["worktree", "remove", "/first", "/second"], ["worktree", "remove", "--force", "--force"],
    ] {
      do {
        _ = try await runServerWorktreeRemove(
          StimCommand(invalid, cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
        Issue.record("Malformed removal selectors must fail before subscribing")
      } catch let error as ServerError { #expect(error.code == "bad-request") }
    }
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.worktree.remove.subscribe") })
    for stdout in ["{}", #"{"removed":"true","exitCode":0}"#, #"{"removed":true,"exitCode":1}"#] {
      let task = Task {
        try await runServerWorktreeRemove(
          StimCommand(["worktree", "remove"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      }
      await settle()
      socket.answer("desktop.worktree.remove.subscribe", .object(["subscription": .string("r1")]))
      socket.reply([
        "event": .string("desktop-worktree-remove-ended"), "subscription": .string("r1"), "exitCode": .number(0),
        "stdout": .string(stdout), "message": .string("Done"),
      ])
      await settle()
      socket.answer("unsubscribe", .object([:]))
      do {
        _ = try await task.value
        Issue.record("A malformed successful removal must fail")
      } catch let error as ServerError { #expect(error.code == "bad-response") }
    }
  }

  @Test func platformCommandsRefuseUnsupportedOptions() async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    for invalid in [
      ["ios", "--slot"], ["ios", "--slot", "--json"], ["ios", "--json", "--json"], ["ios", "--headed"],
      ["macos", "--slot", "fold"], ["web", "--remote", "mini"], ["android", "--plan"],
    ] {
      do {
        _ = try await runServerPlatform(
          StimCommand(invalid, cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
        Issue.record("Unsupported platform command must fail before subscribing")
      } catch let error as ServerError { #expect(error.code == "bad-request") }
    }
  }

  @Test(arguments: ["run", "gc", "worktree.warm"])
  func mutationsRefuseMalformedSuccessReports(action: String) async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer(
      "hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    let reports =
      action == "worktree.warm"
      ? ["{}", #"{"exitCode":1}"#, #"{"exitCode":null}"#]
      : action == "run"
        ? ["{}", #"{"platform":"android","facts":{}}"#, #"{"platform":"ios","facts":null}"#]
        : ["{}", #"{"mode":"unknown","sections":{}}"#, #"{"mode":"delete","sections":null}"#]
    for stdout in reports {
      let task = Task {
        if action == "worktree.warm" {
          _ = try await runServerWorktreeWarm(
            StimCommand(["worktree", "warm"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
            connection: (client, "/tmp/stim-test"))
        } else if action == "gc" {
          _ = try await runServerGc(
            StimCommand(["gc", "--json"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
            connection: (client, "/tmp/stim-test"))
        } else {
          _ = try await runServerPlatform(
            StimCommand(["ios", "--json"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
            connection: (client, "/tmp/stim-test"))
        }
      }
      await settle()
      socket.answer("desktop.\(action).subscribe", .object(["subscription": .string("r1")]))
      socket.reply([
        "event": .string("desktop-\(action.replacingOccurrences(of: ".", with: "-"))-ended"), "subscription": .string("r1"),
        "exitCode": .number(0),
        "stdout": .string(stdout), "message": .string("Run finished."),
      ])
      await settle()
      socket.answer("unsubscribe", .object([:]))
      do {
        _ = try await task.value
        Issue.record("Malformed mutation reports must not be returned as success")
      } catch let error as ServerError { #expect(error.code == "bad-response") }
    }
  }

  @Test(arguments: [false, true], [false, true])
  func machineAccessRequestsUseThePrivateServerAndKeepTypedFailures(explicitTicket: Bool, cancelBeforeFailure: Bool) async throws
  {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test", "PATH": "/does-not-exist"]
    let reader = MachineAccessReader(environment: Task { environment }) { (client, "/tmp/stim-test") }
    let ticket = explicitTicket ? String(repeating: "A", count: 43) : nil
    let task = Task { try await reader.report(cwd: "/selected", ask: true, ticket: ticket) }
    await settle()
    var params: [String: JSONValue] = ["cwd": .string("/selected")]
    if let ticket { params["ticket"] = .string(ticket) }
    #expect(socket.sent.last?["params"] == .object(params))
    socket.answer("desktop.machine-access.subscribe", .object(["subscription": .string("a1")]))
    socket.reply([
      "event": .string("desktop-machine-access-ended"), "subscription": .string("a1"), "exitCode": .number(0),
      "stdout": .string(
        #"{"project":"/selected","findings":[],"remoteMachines":[{"machine":"builder","state":"pending"}],"deviceHosts":[{"machine":"host","state":"approved"}]}"#
      ),
      "message": .string("Machine access report completed."),
    ])
    let report = try await task.value
    #expect(report.remoteMachines?.first?.state == .pending && report.deviceHosts?.first?.state == .approved)
    await settle()
    socket.answer("unsubscribe", .object([:]))
    let failed = Task { try await reader.report(cwd: "/selected", ask: true) }
    await settle()
    socket.answer("desktop.machine-access.subscribe", .object(["subscription": .string("a2")]))
    if cancelBeforeFailure {
      failed.cancel()
      await settle()
    }
    socket.reply([
      "event": .string("desktop-machine-access-ended"), "subscription": .string("a2"), "exitCode": .number(1),
      "stdout": .string(#"{"code":"STIM_CLAIM_UNAVAILABLE","message":"Recover the retained access request."}"#),
      "message": .string("Request failed."),
    ])
    await settle()
    socket.answer("unsubscribe", .object([:]))
    let error = await #expect(throws: ServerError.self) { try await failed.value }
    #expect(error?.code == "STIM_CLAIM_UNAVAILABLE" && error?.message == "Recover the retained access request.")
  }

  @Test(arguments: [0, 1])
  func warmingKeepsProgressAndFailureDiagnosticsAndRejectsRefresh(exit: Int) async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    for invalid in [["worktree", "warm", "--refresh"], ["worktree", "warm", "--json"], ["worktree", "warm", "/target"]] {
      do {
        _ = try await runServerWorktreeWarm(
          StimCommand(invalid, cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
        Issue.record("Warming accepts only the existing bare command")
      } catch let error as ServerError { #expect(error.code == "bad-request") }
    }
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.worktree.warm.subscribe") })
    var lines: [OutputLine] = []
    let task = Task {
      try await runServerWorktreeWarm(
        StimCommand(["worktree", "warm"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
        connection: (client, "/tmp/stim-test"),
        onLine: { lines.append($0) })
    }
    await settle()
    #expect(socket.sent.last?["params"] == .object(["cwd": .string("/selected")]))
    socket.answer("desktop.worktree.warm.subscribe", .object(["subscription": .string("w1")]))
    socket.reply([
      "event": .string("desktop-worktree-warm-progress"), "subscription": .string("w1"), "stream": .string("stderr"),
      "message": .string("Copying ignored files\nCheck the source checkout\n"),
    ])
    let stdout = exit == 0 ? #"{"exitCode":0}"# : #"{"code":"STIM_WARM_INCOMPLETE"}"#
    socket.reply([
      "event": .string("desktop-worktree-warm-ended"), "subscription": .string("w1"), "exitCode": .number(Double(exit)),
      "stdout": .string(stdout), "message": .string("Warm finished"),
    ])
    let result = try await task.value
    #expect(result.exitStatus == Int32(exit) && String(decoding: result.stdout, as: UTF8.self) == stdout)
    #expect(result.message == (exit == 0 ? "Warm finished" : "Copying ignored files\nCheck the source checkout\nWarm finished"))
    #expect(
      lines == [
        OutputLine(.stderr, "Copying ignored files"), OutputLine(.stderr, "Check the source checkout"),
        OutputLine(.stderr, "Warm finished"),
      ])
    await settle()
    socket.answer("unsubscribe", .object([:]))
  }

  @Test func settingsPreserveMaskedResultsAndTypedRefusalsWithoutCLI() async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    let task = Task {
      try await writeServerSetting(
        "android.keystorePassword", value: "private-value", scope: .workspace, cwd: "/selected",
        stimHome: StimHome.path(environment: environment), connection: (client, "/tmp/stim-test"))
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
        "ios.runtime", value: nil, scope: .workspace, cwd: "/selected", stimHome: StimHome.path(environment: environment),
        connection: (client, "/tmp/stim-test"))
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

  @Test(arguments: ["home", "authority"])
  func settingsRefuseWrongHomeServersWithoutAuthorityAndOldServers(reason: String) async throws {
    let key = reason == "authority" ? nil : DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer(
      "hello",
      hello(
        key.map { bootstrapChallenge($0) }))
    await settle()
    if key != nil {
      socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
      await settle()
    }
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    do {
      _ = try await writeServerSetting(
        "ios.runtime", value: "26.4", scope: .workspace, cwd: "/selected", stimHome: StimHome.path(environment: environment),
        connection: (client, reason == "home" ? "/another-home" : "/tmp/stim-test"))
      Issue.record("Settings must refuse this connection")
    } catch let error as ServerError {
      #expect(error.code == "not-connected")
      #expect(error.message.contains("on this stim-server") == (reason == "authority"))
    }
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.settings.write") })
  }

  @Test func cancellingSettingsKeepsTheSharedConnectionAndIgnoresTheLateReply() async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    let task = Task {
      try await writeServerSetting(
        "ios.runtime", value: nil, scope: .workspace, cwd: "/selected", stimHome: StimHome.path(environment: environment),
        connection: (client, "/tmp/stim-test"))
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

  @Test(arguments: ["settings", "reload", "start", "run", "gc", "worktree.remove", "worktree.warm", "remedy"])
  func mutationsDoNotReplayAfterTheConnectionDropsAndReconnects(action: String) async throws {
    let method = action == "settings" ? "desktop.settings.write" : "desktop.\(action).subscribe"
    let key = DesktopBootstrapKey.random()
    var sockets: [FakeTransport] = []
    var reconnect: (@MainActor () -> Void)?
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim-test/server/local.sock"), clientName: "Stim Desktop", clientVersion: "1",
      bootstrap: { key },
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
    first.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    first.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    let task = Task {
      if action == "settings" {
        _ = try await writeServerSetting(
          "ios.runtime", value: "26.4", scope: .workspace, cwd: "/selected", stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else if action == "start" {
        _ = try await runServerStart(
          StimCommand([action], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else if action == "run" {
        _ = try await runServerPlatform(
          StimCommand(["ios"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else if action == "worktree.remove" {
        _ = try await runServerWorktreeRemove(
          StimCommand(["worktree", "remove"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else if action == "worktree.warm" {
        _ = try await runServerWorktreeWarm(
          StimCommand(["worktree", "warm"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else if action == "remedy" {
        _ = try await runServerRemedy(
          StimCommand(["doctor", "--fix"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else if action == "gc" {
        _ = try await runServerGc(
          StimCommand(["gc"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else {
        _ = try await runServerReload(
          StimCommand(["reload"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
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
    second.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    second.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    #expect(client.isOpen && client.hasDesktopAuthority)
    #expect(!second.sent.contains { $0["method"] == .string(method) })
  }

  @Test(arguments: ["stop", "reload"])
  func cancellingAnActionUnsubscribesWithoutDisconnectingTheSharedClient(action: String) async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    let task = Task {
      if action == "stop" {
        _ = try await runServerStop(
          StimCommand([action], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else if action == "start" {
        _ = try await runServerStart(
          StimCommand([action], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else {
        _ = try await runServerReload(
          StimCommand([action], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
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

  @Test(
    arguments: [(false, false), (false, true), (true, false), (true, true)],
    ["start", "run", "gc", "worktree.remove", "worktree.warm", "remedy", "machine-access"])
  func lifecycleCancellationWaitsForCleanupAcknowledgement(state: (Bool, Bool), action: String) async throws {
    let (accepted, retained) = state
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer(
      "hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    var returned = false
    let task = Task {
      defer { returned = true }
      if action == "machine-access" {
        _ = try await MachineAccessReader(environment: Task { environment }) { (client, "/tmp/stim-test") }.report(
          cwd: "/selected", ask: true)
      } else if action == "run" {
        _ = try await runServerPlatform(
          StimCommand(["ios"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else if action == "worktree.remove" {
        _ = try await runServerWorktreeRemove(
          StimCommand(["worktree", "remove"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else if action == "worktree.warm" {
        _ = try await runServerWorktreeWarm(
          StimCommand(["worktree", "warm"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else if action == "remedy" {
        _ = try await runServerRemedy(
          StimCommand(["doctor", "--fix"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else if action == "gc" {
        _ = try await runServerGc(
          StimCommand(["gc"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      } else {
        _ = try await runServerStart(
          StimCommand(["start"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
      }
    }
    await settle()
    if accepted { socket.answer("desktop.\(action).subscribe", .object(["subscription": .string("s1")])) }
    task.cancel()
    await settle()
    #expect(!returned)
    if !accepted { socket.answer("desktop.\(action).subscribe", .object(["subscription": .string("s1")])) }
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

  @Test(arguments: [false, true], ["start", "run", "gc", "worktree.remove", "worktree.warm", "remedy"])
  func lifecycleCancellationPreservesATerminalRecoveryAlreadyDispatched(beforeCancel: Bool, action: String) async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer(
      "hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    let task = Task {
      if action == "run" {
        let result = try await runServerPlatform(
          StimCommand(["ios", "--json"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
        return (exitStatus: result.exitStatus, stdout: result.stdout, message: result.message)
      } else if action == "worktree.remove" {
        let result = try await runServerWorktreeRemove(
          StimCommand(["worktree", "remove"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
        return (exitStatus: result.exitStatus, stdout: result.stdout, message: result.message)
      } else if action == "worktree.warm" {
        let result = try await runServerWorktreeWarm(
          StimCommand(["worktree", "warm"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
        return (exitStatus: result.exitStatus, stdout: result.stdout, message: result.message)
      } else if action == "remedy" {
        let result = try await runServerRemedy(
          StimCommand(["doctor", "--fix"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
        return (exitStatus: result.exitStatus, stdout: result.stdout, message: result.message)
      } else if action == "gc" {
        let result = try await runServerGc(
          StimCommand(["gc", "--json"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
        return (exitStatus: result.exitStatus, stdout: result.stdout, message: result.message)
      } else {
        let result = try await runServerStart(
          StimCommand(["start", "--json"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: (client, "/tmp/stim-test"))
        return (exitStatus: result.exitStatus, stdout: result.stdout, message: result.message)
      }
    }
    await settle()
    socket.answer("desktop.\(action).subscribe", .object(["subscription": .string("s1")]))
    let failure: [String: JSONValue] = [
      "event": .string("desktop-\(action.replacingOccurrences(of: ".", with: "-"))-ended"), "subscription": .string("s1"),
      "exitCode": .number(1),
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

  @Test(
    arguments: ["home", "authority"],
    ["stop", "reload", "start", "run", "gc", "worktree.remove", "worktree.warm", "remedy", "machine-access"])
  func actionsRefuseWrongHomeMissingAuthorityAndOldServers(reason: String, action: String) async throws {
    let key = reason == "authority" ? nil : DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer(
      "hello",
      hello(
        key.map { bootstrapChallenge($0) }))
    await settle()
    if key != nil {
      socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
      await settle()
    }
    let environment = ["STIM_HOME": "/tmp/stim-test"]
    do {
      let connection = (client, reason == "home" ? "/another-home" : "/tmp/stim-test")
      if action == "machine-access" {
        _ = try await MachineAccessReader(environment: Task { environment }) { connection }.report(cwd: "/selected", ask: true)
      } else if action == "stop" {
        _ = try await runServerStop(
          StimCommand([action], cwd: "/selected"), stimHome: StimHome.path(environment: environment), connection: connection)
      } else if action == "start" {
        _ = try await runServerStart(
          StimCommand([action], cwd: "/selected"), stimHome: StimHome.path(environment: environment), connection: connection)
      } else if action == "run" {
        _ = try await runServerPlatform(
          StimCommand(["ios"], cwd: "/selected"), stimHome: StimHome.path(environment: environment), connection: connection)
      } else if action == "worktree.remove" {
        _ = try await runServerWorktreeRemove(
          StimCommand(["worktree", "remove"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: connection)
      } else if action == "worktree.warm" {
        _ = try await runServerWorktreeWarm(
          StimCommand(["worktree", "warm"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: connection)
      } else if action == "remedy" {
        _ = try await runServerRemedy(
          StimCommand(["doctor", "--fix"], cwd: "/selected"), stimHome: StimHome.path(environment: environment),
          connection: connection)
      } else if action == "gc" {
        _ = try await runServerGc(
          StimCommand(["gc"], cwd: "/selected"), stimHome: StimHome.path(environment: environment), connection: connection)
      } else {
        _ = try await runServerReload(
          StimCommand([action], cwd: "/selected"), stimHome: StimHome.path(environment: environment), connection: connection)
      }
      Issue.record("Action must refuse this connection")
    } catch let error as ServerError {
      #expect(error.code == "not-connected")
    }
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.\(action).subscribe") })
  }

  @Test func authorityRequiresBothTheChildProofAndTheServerAcceptanceAndEndsOnDisconnect() async throws {
    let key = DesktopBootstrapKey.random()
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
    let (client, socket) = try await client(key: DesktopBootstrapKey.random())
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(DesktopBootstrapKey.random())))
    await settle()
    #expect(!client.isOpen && !client.hasDesktopAuthority && socket.closed)
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.authenticate") })
  }

  @Test func disconnectWhileAuthenticatingCannotRestoreAuthorityWithALateReply() async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    socket.answer("hello", hello(bootstrapChallenge(key)))
    await settle()
    socket.onEvent(.closed("interrupted"))
    socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
    await settle()
    #expect(!client.isOpen && !client.hasDesktopAuthority)
  }

  @Test(arguments: [false, true]) func serversThatOfferNoDesktopActionsStayConnectedWithoutAuthority(hasKey: Bool) async throws {
    let (client, socket) = try await client(key: hasKey ? DesktopBootstrapKey.random() : nil)
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

  @Test(arguments: [false, true]) func aServerWithoutAPrivateKeyGrantsItsLocalSocketAuthorityWithoutAProof(hasKey: Bool)
    async throws
  {
    let (client, socket) = try await client(key: hasKey ? DesktopBootstrapKey.random() : nil)
    defer { client.stop() }
    socket.answer("hello", hello(owner: "cli"))
    await settle()
    #expect(client.isOpen && client.hasDesktopAuthority)
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.authenticate") })
    socket.onEvent(.closed("restarted"))
    #expect(!client.isOpen && !client.hasDesktopAuthority)
  }

  @Test func anAdoptedDesktopServerWithoutThePrivateProofIsNotTrusted() async throws {
    let (client, socket) = try await client(key: nil)
    defer { client.stop() }
    socket.answer("hello", hello())
    await settle()
    #expect(client.isOpen && !client.hasDesktopAuthority)
  }

  @Test func aPairedServerNeverGetsLocalAuthority() async throws {
    var socket: FakeTransport?
    let client = ServerClient(
      endpoint: URL(string: "ws://100.64.0.1:7787")!, clientName: "Stim Desktop", clientVersion: "1",
      transport: { _, event in
        let next = FakeTransport(onEvent: event)
        socket = next
        return next
      },
      scheduler: { _, _ in {} })
    client.start()
    await settle()
    defer { client.stop() }
    try #require(socket).answer("hello", hello(owner: "cli"))
    await settle()
    #expect(client.isOpen && !client.hasDesktopAuthority)
  }

  @Test(arguments: [nil, 0, 2] as [Int?])
  func refusesAnIncompatibleDesktopApiBeforeSendingProof(api: Int?) async throws {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: key)
    defer { client.stop() }
    guard case .object(var fields) = hello(bootstrapChallenge(key)) else { return }
    fields["desktopApi"] = api.map { .number(Double($0)) }
    if api == nil { fields["host"] = .object(["screenRecording": .bool(true)]) }
    socket.answer("hello", .object(fields))
    await settle()
    guard case .refused(let error) = client.state else {
      Issue.record("Expected an API refusal")
      return
    }
    #expect(error.code == "protocol-unsupported")
    #expect(error.message.contains(api == 2 ? "Update Stim Desktop" : "run stim engine update"))
    #expect(!client.hasDesktopAuthority)
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.authenticate") })
  }

  private func planClient(authority: Bool = true) async throws -> (
    ServerClient, FakeTransport, [String: String]
  ) {
    let key = DesktopBootstrapKey.random()
    let (client, socket) = try await client(key: authority ? key : nil)
    socket.answer("hello", hello(authority ? bootstrapChallenge(key) : nil))
    await settle()
    if authority {
      socket.answer("desktop.authenticate", .object(["authorized": .bool(true)]))
      await settle()
    }
    return (client, socket, ["STIM_HOME": "/tmp/stim-test"])
  }

  @Test(arguments: ["ios", "android", "macos"])
  func buildPlanReadsPreserveMetadataAndTypedRefusals(platform: String) async throws {
    let (client, socket, environment) = try await planClient()
    defer { client.stop() }
    let task = Task {
      try await readServerBuildPlan(
        platform: platform, workspace: "/selected", stimHome: StimHome.path(environment: environment),
        connection: (client, "/tmp/stim-test"))
    }
    await settle()
    guard case .object(let params)? = socket.sent.last?["params"] else {
      Issue.record("Expected a selected-folder plan request")
      return
    }
    #expect(params["cwd"] == .string("/selected") && params["platform"] == .string(platform))
    #expect(params["request"]?.string?.isEmpty == false)
    socket.answer(
      "desktop.plan.get",
      .object([
        "platform": .string(platform), "fingerprint": platform == "macos" ? .null : .string("exact-inputs"),
        "cacheHit": platform == "macos" ? .bool(false) : .string("remote"), "cacheSkipped": .bool(false),
        "provider": .string("fixture-provider"), "prebuild": .null, "outcome": .null,
        "expectedMs": .number(1200), "basis": .number(3), "product": .string("Fixture"), "buildMachine": .string("local"),
      ]))
    guard case .plan(let plan) = try await task.value else {
      Issue.record("Expected a build plan")
      return
    }
    #expect(plan.platform == platform && plan.expectedMs == 1200 && plan.basis == 3)
    #expect(plan.cacheHit == (platform == "macos" ? .none : .remote))
    let refusal = Task {
      try await readServerBuildPlan(
        platform: platform, workspace: "/selected", stimHome: StimHome.path(environment: environment),
        connection: (client, "/tmp/stim-test"))
    }
    await settle()
    socket.answer(
      "desktop.plan.get",
      .object([
        "code": .string("STIM_NO_DEVICE"), "message": .string("No image installed."), "remedy": .string("Install one."),
      ]))
    #expect(
      try await refusal.value
        == .refused(
          CommandRefusal(
            code: "STIM_NO_DEVICE", message: "No image installed.", remedy: "Install one.")))
  }

  @Test(arguments: ["home", "authority"])
  func buildPlanReadsRefuseAnUnavailableBundledServer(reason: String) async throws {
    let (client, _, environment) = try await planClient(authority: reason != "authority")
    defer { client.stop() }
    do {
      _ = try await readServerBuildPlan(
        platform: "ios", workspace: "/selected", stimHome: StimHome.path(environment: environment),
        connection: (client, reason == "home" ? "/other" : "/tmp/stim-test"))
      Issue.record("A plan needs the matching bundled server and feature")
    } catch let error as ServerError {
      #expect(error.code == "not-connected")
    }
  }

  @Test(arguments: [false, true])
  func cancellingACheckSurfacesCleanupRefusalWithoutOverwritingItsReplacement(replyFirst: Bool) async throws {
    let (client, socket, environment) = try await planClient()
    defer { client.stop() }
    var refusals: [CommandRefusal] = []
    let checks = BuildPlanChecks { platform, workspace in
      try await readServerBuildPlan(
        platform: platform, workspace: workspace, stimHome: StimHome.path(environment: environment),
        connection: (client, "/tmp/stim-test"))
    }
    checks.onCancelledRefusal = { workspace, platform, refusal in
      #expect(workspace == "/selected" && platform == "ios")
      refusals.append(refusal)
    }
    let refusal = CommandRefusal(code: "STIM_CLAIM_UNAVAILABLE", message: "Retained /scratch/plan.", remedy: "Check ownership.")
    checks.check(workspace: "/selected", builds: ["ios": "old"])
    await settle()
    if replyFirst {
      socket.answer(
        "desktop.plan.get",
        .object([
          "code": .string(refusal.code), "message": .string(refusal.message), "remedy": .string("Check ownership."),
        ]))
    }
    checks.cancel(workspace: "/selected")
    checks.check(workspace: "/selected", builds: ["ios": "new"])
    await settle()
    #expect(socket.sent.last?["method"] == .string("desktop.plan.cancel"))
    #expect(refusals.isEmpty)
    socket.answer(
      "desktop.plan.cancel",
      .object([
        "cancelled": .bool(true),
        "refusal": .object([
          "code": .string(refusal.code), "message": .string(refusal.message), "remedy": .string("Check ownership."),
        ]),
      ]))
    await settle()
    #expect(refusals == [refusal])
    #expect(checks.entry(workspace: "/selected", platform: "ios")?.buildKey == "new")
    #expect(checks.entry(workspace: "/selected", platform: "ios")?.state == .checking)
    socket.answer(
      "desktop.plan.get",
      .object(["code": .string("STIM_NO_DEVICE"), "message": .string("Install an image."), "remedy": .null]))
    await settle()
    #expect(
      checks.entry(workspace: "/selected", platform: "ios")?.state
        == .done(.refused(CommandRefusal(code: "STIM_NO_DEVICE", message: "Install an image.", remedy: nil))))
    #expect(refusals == [refusal] && client.isOpen)
  }

  @Test(arguments: [false, true])
  func aTimedOutCheckDrainsBeforeReturningItsCleanupRefusalOrOriginalError(retained: Bool) async throws {
    let (client, socket, environment) = try await planClient()
    defer { client.stop() }
    let checks = BuildPlanChecks { platform, workspace in
      try await readServerBuildPlan(
        platform: platform, workspace: workspace, stimHome: StimHome.path(environment: environment),
        connection: (client, "/tmp/stim-test"))
    }
    checks.check(workspace: "/selected", builds: ["ios": "old"])
    await settle()
    socket.refuse("desktop.plan.get", code: "stim-failed")
    await settle()
    #expect(socket.sent.last?["method"] == .string("desktop.plan.cancel"))
    #expect(checks.entry(workspace: "/selected", platform: "ios")?.state == .checking)
    let refusal = CommandRefusal(code: "STIM_CLAIM_UNAVAILABLE", message: "Retained /scratch/plan.", remedy: "Check ownership.")
    var reply: [String: JSONValue] = ["cancelled": .bool(true)]
    if retained {
      reply["refusal"] = .object([
        "code": .string(refusal.code), "message": .string(refusal.message), "remedy": .string("Check ownership."),
      ])
    }
    socket.answer("desktop.plan.cancel", .object(reply))
    await settle()
    #expect(
      checks.entry(workspace: "/selected", platform: "ios")?.state
        == (retained ? .done(.refused(refusal)) : .failed("stim-failed")))
    #expect(client.isOpen)
  }

  @Test(arguments: [false, true])
  func cancellingABuildPlanWaitsForItsOwnDrainWithoutDisconnecting(retained: Bool) async throws {
    let (client, socket, environment) = try await planClient()
    defer { client.stop() }
    var ended = false
    let task = Task {
      defer { ended = true }
      return try await readServerBuildPlan(
        platform: "ios", workspace: "/selected", stimHome: StimHome.path(environment: environment),
        connection: (client, "/tmp/stim-test"))
    }
    await settle()
    let request = socket.sent.last?["params"]
    task.cancel()
    await settle()
    #expect(!ended && client.isOpen)
    #expect(socket.sent.last?["method"] == .string("desktop.plan.cancel"))
    guard case .object(let get)? = request, case .object(let cancel)? = socket.sent.last?["params"] else {
      Issue.record("Expected a connection-scoped cancellation")
      return
    }
    #expect(cancel["request"] == get["request"])
    let refusal = CommandRefusal(code: "STIM_CLAIM_UNAVAILABLE", message: "Retained /scratch/plan.", remedy: "Check ownership.")
    var reply: [String: JSONValue] = ["cancelled": .bool(true)]
    if retained {
      reply["refusal"] = .object([
        "code": .string(refusal.code), "message": .string(refusal.message), "remedy": .string("Check ownership."),
      ])
    }
    socket.answer("desktop.plan.cancel", .object(reply))
    if retained {
      #expect(try await task.value == .refused(refusal))
    } else {
      await #expect(throws: CancellationError.self) { try await task.value }
    }
    #expect(client.isOpen && ended)
  }

}

extension DesktopBootstrapKey {
  /// A key as stimd writes one to `run/desktop.key`, and its file text.
  static func random() -> DesktopBootstrapKey {
    DesktopBootstrapKey(encoded: base64URL(Data((0..<32).map { _ in UInt8.random(in: 0...255) })))!
  }

  var input: Data { Data((base64URL(key.withUnsafeBytes { Data($0) }) + "\n").utf8) }
}

private func base64URL(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}
