import CryptoKit
import Foundation
import StimKit
import Testing

@testable import StimStores

@MainActor
struct ActionCenterTests {
  @Test(arguments: [["doctor", "--json"], ["doctor"], ["doctor", "--platform", "android"]])
  func projectChecksKeepOperationResultsAndRefuseAnotherHomeWithoutCLI(arguments: [String]) async throws {
    var transport: DoctorTransport?
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim/server/local.sock"), clientName: "Doctor", clientVersion: "1",
      transport: { _, onEvent in
        let next = DoctorTransport(onEvent: onEvent)
        transport = next
        return next
      })
    client.start()
    defer { client.stop() }
    #expect(await until { client.isOpen })
    let socket = try #require(transport)
    let environment = Task { ["STIM_HOME": "/tmp/stim"] }
    let center = ActionCenter(environment: environment) { (client, "/tmp/stim") }
    let command = StimCommand(arguments, cwd: "/selected")
    var finishes = 0
    let first = try #require(
      center.run("Check project", steps: [command], key: "onboarding", present: false) { _ in finishes += 1 })
    #expect(center.run("Again", steps: [command], key: "onboarding", present: false) == nil)
    #expect(center.operations.running.map(\.id) == [first.id])
    #expect(await until { socket.sent.last?["method"] == .string("desktop.doctor.run") })
    var expected: [String: JSONValue] = ["cwd": .string("/selected")]
    if arguments.contains("android") { expected["platform"] = .string("android") }
    #expect(socket.sent.last?["params"] == .object(expected))
    let report: JSONValue = .object(["project": .string("/selected"), "findings": .array([])])
    socket.answer(report)
    #expect(await until { first.exitStatus != nil })
    #expect(first.exitStatus == 0 && finishes == 1)
    if arguments.contains("--json") {
      #expect(try JSONDecoder().decode(JSONValue.self, from: first.stdout) == report)
    } else {
      #expect(first.logLines.contains { $0.text == "Doctor completed with 0 finding(s)." })
    }
    #expect(center.latest(for: "onboarding")?.id == first.id && center.active(for: "onboarding") == nil)
    #expect(center.presented == nil)

    let failed = try #require(center.run("Check again", steps: [command], key: "onboarding", present: false))
    #expect(await until { socket.sent.filter { $0["method"] == .string("desktop.doctor.run") }.count == 2 })
    socket.refuse()
    #expect(await until { failed.exitStatus != nil })
    #expect(failed.exitStatus == 1 && failed.logLines.contains { $0.text.contains("refused") })
    #expect(client.isOpen)

    let wrong = ActionCenter(environment: environment) { (client, "/another-home") }
    let refused = try #require(wrong.run("Check", steps: [command], key: "onboarding", present: false))
    #expect(await until { refused.launchError != nil })
    #expect(refused.launchError?.contains("not ready") == true)
    #expect(socket.sent.filter { $0["method"] == .string("desktop.doctor.run") }.count == 2)
  }

  @Test(arguments: [
    ["doctor", "--fix"], ["device", "unlock", "ios", "--slot", "secondary"],
    ["stop"], ["start"], ["reload"], ["reload", "web", "--json"], ["ios"], ["android"], ["macos"], ["web"],
    ["gc", "--delete", "--json"], ["gc", "--idle", "30m", "--json"],
    ["worktree", "remove"], ["worktree", "remove", "/target", "--force"], ["worktree", "warm"],
    ["settings", "set", "iosSimulatorApp", "stim-desktop", "--scope", "machine"],
    ["settings", "unset", "iosSimulatorApp", "--scope", "machine"],
  ])
  func anUnavailableMutationFailsActivityWithoutCLIFallbackAndRunsTheNextStep(arguments: [String]) async throws {
    let environment = Task { ["PATH": "/usr/bin:/bin"] }
    let center = ActionCenter(environment: environment)
    let mutation = StimCommand(arguments, cwd: "/selected")
    let next = StimCommand([], cwd: "/tmp", program: "true")
    var finishes = 0
    let run = try #require(center.run("Change workspace", steps: [mutation, next], present: false) { _ in finishes += 1 })
    #expect(await until { run.exitStatus != nil })
    #expect(run.exitStatus == 1 && finishes == 1)
    #expect(run.launchError == nil && center.active(for: "/selected") == nil)
    #expect(run.logLines.contains { $0.text.contains("bundled local stim-server is not ready") })
    #expect(run.logLines.contains { $0.text == "$ true" })
    #expect(center.operations.attentionCount == 1 && center.latest(for: "/selected")?.id == run.id)
  }

  @Test(arguments: ["reload", "start", "run", "gc", "worktree.remove", "worktree.warm"])
  func lifecycleActionsKeepResultsInActivityAndRunTheNextStepWithoutCLI(action: String) async throws {
    let key = DesktopBootstrapKey()
    var transport: DoctorTransport?
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim/server/local.sock"), clientName: "Reload", clientVersion: "1",
      serverPort: 7787, bootstrap: { key },
      transport: { _, onEvent in
        let next = DoctorTransport(onEvent: onEvent, key: key)
        transport = next
        return next
      })
    client.start()
    defer { client.stop() }
    #expect(await until { client.isOpen })
    let socket = try #require(transport)
    let environment = Task { ["STIM_HOME": "/tmp/stim", "PATH": "/usr/bin:/bin"] }
    let center = ActionCenter(environment: environment) { (client, "/tmp/stim") }
    let command = StimCommand(
      action == "worktree.remove"
        ? ["worktree", "remove"]
        : action == "worktree.warm"
          ? ["worktree", "warm"]
          : action == "reload" ? ["reload", "web", "--json"] : action == "run" ? ["ios", "--json"] : [action, "--json"],
      cwd: "/selected")
    let next = StimCommand([], cwd: "/tmp", program: "true")
    let run = try #require(center.run("Reload", steps: [command, next], present: false))
    #expect(await until { socket.sent.last?["method"] == .string("desktop.\(action).subscribe") })
    #expect(center.operations.running.map(\.id) == [run.id])
    socket.answer(.object(["subscription": .string("r1")]))
    let json =
      action == "worktree.warm"
      ? #"{"exitCode":0}"#
      : action == "run"
        ? #"{"bundleId":"fixture"}"#
        : action == "worktree.remove"
          ? #"{"removed":false,"exitCode":0}"#
          : action == "gc" ? #"{"mode":"dry-run","sections":{}}"# : #"{"platform":"web","strategy":"cdp"}"#
    socket.reply([
      "event": .string("desktop-\(action.replacingOccurrences(of: ".", with: "-"))-ended"), "subscription": .string("r1"),
      "exitCode": .number(0),
      "stdout": .string(action == "run" ? #"{"platform":"ios","facts":{"bundleId":"fixture"}}"# : json),
      "message": .string("Reload requested. Completion is not observed."),
    ])
    #expect(await until { run.exitStatus != nil })
    #expect(run.exitStatus == 0 && run.launchError == nil)
    if action == "worktree.remove" || action == "worktree.warm" {
      #expect(run.lines.contains(OutputLine(.stderr, "Reload requested. Completion is not observed.")))
      #expect(run.stdout.isEmpty && run.lines.allSatisfy { $0.channel == .stderr })
    } else {
      #expect(run.lines.contains(OutputLine(.stdout, json)))
    }
    #expect(run.logLines.contains { $0.text == "$ true" })
    #expect(center.active(for: "/selected") == nil && center.latest(for: "/selected")?.id == run.id)
  }

  @Test(arguments: [
    ["doctor", "--fix", "--platform", "android", "--json"], ["doctor", "--fix", "--platform", "android"],
    ["device", "unlock", "ios", "--slot", "secondary", "--json"],
  ])
  func repairActionsKeepProgressAndTerminalRefusalsWithoutCLI(arguments: [String]) async throws {
    let key = DesktopBootstrapKey()
    var transport: DoctorTransport?
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim/server/local.sock"), clientName: "Repair", clientVersion: "1",
      serverPort: 7787, bootstrap: { key },
      transport: { _, onEvent in
        let next = DoctorTransport(onEvent: onEvent, key: key)
        transport = next
        return next
      })
    client.start()
    defer { client.stop() }
    #expect(await until { client.isOpen })
    let socket = try #require(transport)
    let center = ActionCenter(environment: Task { ["STIM_HOME": "/tmp/stim", "PATH": "/does-not-exist"] }) {
      (client, "/tmp/stim")
    }
    let command = StimCommand(arguments, cwd: "/selected")
    for exit in [0, 1] {
      let run = try #require(center.run("Repair", steps: [command], present: false))
      #expect(await until { socket.sent.last?["method"] == .string("desktop.remedy.subscribe") })
      let doctor = arguments.first == "doctor"
      var params: [String: JSONValue] = [
        "cwd": .string("/selected"), "action": .string(doctor ? "doctor-fix" : "device-unlock"),
        "platform": .string(doctor ? "android" : "ios"),
      ]
      if !doctor { params["slot"] = .string("secondary") }
      #expect(socket.sent.last?["params"] == .object(params))
      socket.answer(.object(["subscription": .string("repair")]))
      socket.reply([
        "event": .string("desktop-remedy-progress"), "subscription": .string("repair"), "stream": .string("stderr"),
        "message": .string("kept tracked output"),
      ])
      let stdout =
        doctor
        ? #"{"project":"/selected","findings":[{"level":"cost","title":"Approve worker","detail":"Build access is pending.","fix":"Run stim-server setup on the worker."}]}"#
        : "[]"
      socket.reply([
        "event": .string("desktop-remedy-ended"), "subscription": .string("repair"), "exitCode": .number(Double(exit)),
        "stdout": .string(stdout), "message": .string(exit == 0 ? "Completed" : "Repair refused"),
      ])
      #expect(await until { run.exitStatus != nil })
      #expect(run.exitStatus == Int32(exit) && run.launchError == nil)
      if arguments.contains("--json") {
        #expect(String(decoding: run.stdout, as: UTF8.self).trimmingCharacters(in: .newlines) == stdout)
      } else {
        #expect(run.lines.contains(OutputLine(.stdout, "Approve worker: Build access is pending.")))
        #expect(run.lines.contains(OutputLine(.stdout, "Run stim-server setup on the worker.")))
        #expect(run.lines.contains(OutputLine(.stdout, "Doctor completed with 1 finding(s).")))
      }
      #expect(run.logLines.contains { $0.text == "kept tracked output" })
      #expect(run.needsAttention == (exit == 1))
      #expect(await until { socket.sent.last?["method"] == .string("unsubscribe") })
    }
  }

  @Test func settingsKeepJSONAndRefusalsInActivityWithoutCLI() async throws {
    let key = DesktopBootstrapKey()
    var transport: DoctorTransport?
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim/server/local.sock"), clientName: "Settings", clientVersion: "1",
      serverPort: 7787, bootstrap: { key },
      transport: { _, onEvent in
        let next = DoctorTransport(onEvent: onEvent, key: key)
        transport = next
        return next
      })
    client.start()
    defer { client.stop() }
    #expect(await until { client.isOpen })
    let socket = try #require(transport)
    let environment = Task { ["STIM_HOME": "/tmp/stim", "PATH": "/usr/bin:/bin"] }
    let center = ActionCenter(environment: environment) { (client, "/tmp/stim") }
    let set = StimCommand(
      ["settings", "set", "android.keystorePassword", "--json", "--scope", "workspace", "--json"], cwd: "/selected")
    let first = try #require(center.run("Change setting", steps: [set], present: false))
    #expect(await until { socket.sent.last?["method"] == .string("desktop.settings.write") })
    #expect(
      socket.sent.last?["params"]
        == .object([
          "cwd": .string("/selected"), "key": .string("android.keystorePassword"), "value": .string("--json"),
          "action": .string("set"), "scope": .string("workspace"),
        ]))
    let payload: JSONValue = .object([
      "setting": .object([
        "key": .string("android.keystorePassword"), "value": .string("********"), "origin": .string("workspace"),
        "layers": .object(["workspace": .string("********")]),
      ])
    ])
    socket.answer(payload)
    #expect(await until { first.exitStatus != nil })
    #expect(first.exitStatus == 0)
    #expect(try JSONDecoder().decode(JSONValue.self, from: first.stdout) == payload)

    let unset = StimCommand(["settings", "unset", "ios.runtime", "--scope", "workspace"], cwd: "/selected")
    let next = StimCommand([], cwd: "/tmp", program: "true")
    let second = try #require(center.run("Reset setting", steps: [unset, next], present: false))
    #expect(await until { socket.sent.filter { $0["method"] == .string("desktop.settings.write") }.count == 2 })
    #expect(
      socket.sent.last?["params"]
        == .object([
          "cwd": .string("/selected"), "key": .string("ios.runtime"), "action": .string("unset"), "scope": .string("workspace"),
        ]))
    socket.answer(
      .object([
        "code": .string("STIM_NO_PROJECT"), "message": .string("No app"), "remedy": .string("Choose an app"),
      ]))
    #expect(await until { second.exitStatus != nil })
    #expect(second.exitStatus == 1 && second.logLines.contains { $0.text.contains("STIM_NO_PROJECT: No app Choose an app") })
    #expect(second.logLines.contains { $0.text == "$ true" })
    #expect(client.isOpen && center.operations.attentionCount == 1)
  }

  #if DEBUG
    @Test func fixtureActionsDoNotCreateLiveOperations() {
      var simulated: [String] = []
      let center = ActionCenter(fixtureAction: { simulated.append($0) })
      let command = StimCommand(["ios"], cwd: "/Playground/app")

      let run = center.run("Build fixture", steps: [command])

      #expect(simulated == ["Build fixture"])
      #expect(run == nil)
      #expect(center.runs.isEmpty)
      #expect(center.operations.runs.isEmpty)
      #expect(center.presented == nil)
    }
  #endif

  @Test func runAppKeepsPendingAndFailedOutputInOperationsWithoutPresentingASheet() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let environment = Task {
      ["PATH": "/usr/bin:/bin", "STIM_HOME": root.path]
    }
    let center = ActionCenter(environment: environment)
    let env = try JSONDecoder().decode(
      Workspace.self, from: JSONSerialization.data(withJSONObject: ["path": root.path, "live": false, "warnings": []]))

    center.runApp(env, platform: "ios")

    let run = try #require(center.latest(for: env.path))
    #expect(center.presented == nil)
    #expect(center.active(for: env.path)?.id == run.id)
    #expect(center.operations.running.map(\.id) == [run.id])
    #expect(run.command.arguments == ["ios"] && run.command.cwd == env.path)
    #expect(await until { run.exitStatus != nil })
    #expect(center.active(for: env.path) == nil)
    #expect(center.latest(for: env.path)?.id == run.id)
    #expect(center.operations.attentionCount == 1)
    #expect(center.presented == nil)

    center.presented = run
    #expect(center.operations.attentionCount == 0)
  }
}

@MainActor private final class DoctorTransport: ServerTransport {
  var sent: [[String: JSONValue]] = []
  let onEvent: @MainActor (ServerTransportEvent) -> Void
  let key: DesktopBootstrapKey?

  init(onEvent: @escaping @MainActor (ServerTransportEvent) -> Void, key: DesktopBootstrapKey? = nil) {
    self.onEvent = onEvent
    self.key = key
  }
  func close() {}
  func send(_ text: String) {
    guard case .object(let message) = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { return }
    sent.append(message)
    if message["method"] == .string("hello") {
      var fields: [String: JSONValue] = [
        "protocol": .number(2),
        "server": .object([
          "name": .string("Mac"), "version": .string("1"), "stim": .string("1"), "port": .number(7787),
        ]),
        "capabilities": .array([.string("read"), .string("control")]),
        "features": .array([
          .string("desktop-doctor-run"), .string("desktop-remedy"), .string("desktop-settings-write"),
          .string("desktop-reload"), .string("desktop-start"),
          .string("desktop-run"), .string("desktop-gc"), .string("desktop-worktree-remove"), .string("desktop-worktree-warm"),
        ]),
      ]
      if let key {
        let nonce = String(repeating: "A", count: 43)
        let encoded = String(decoding: key.input, as: UTF8.self).trimmingCharacters(in: .newlines)
        let data = Data(
          base64Encoded: encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "=")!
        let proof = Data(HMAC<SHA256>.authenticationCode(for: Data("server:\(nonce)".utf8), using: SymmetricKey(data: data)))
          .base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
          .replacingOccurrences(of: "=", with: "")
        fields["desktopBootstrap"] = .object(["nonce": .string(nonce), "proof": .string(proof)])
      }
      answer(.object(fields))
    } else if message["method"] == .string("desktop.authenticate") {
      answer(.object(["authorized": .bool(true)]))
    }
  }
  func answer(_ result: JSONValue) { reply(["id": sent.last!["id"]!, "result": result]) }
  func refuse() {
    reply(["id": sent.last!["id"]!, "error": .object(["code": .string("stim-failed"), "message": .string("refused")])])
  }
  func reply(_ message: [String: JSONValue]) {
    onEvent(.text(String(decoding: try! JSONEncoder().encode(JSONValue.object(message)), as: UTF8.self)))
  }
}
