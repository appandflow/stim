import Foundation
import StimKit
import Testing

@testable import StimStores

@MainActor
struct ActionCenterTests {
  @Test func projectChecksKeepOperationResultsAndRefuseAnotherHomeWithoutCLI() async throws {
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
    let cli = Task { StimCLI(environment: ["STIM_HOME": "/tmp/stim"], override: "/does-not-exist/stim") }
    let center = ActionCenter(cli: cli) { (client, "/tmp/stim") }
    let command = StimCommand(["doctor", "--json"], cwd: "/selected")
    var finishes = 0
    let first = try #require(
      center.run("Check project", steps: [command], key: "onboarding", present: false) { _ in finishes += 1 })
    #expect(center.run("Again", steps: [command], key: "onboarding", present: false) == nil)
    #expect(center.operations.running.map(\.id) == [first.id])
    #expect(await until { socket.sent.last?["method"] == .string("desktop.doctor.run") })
    #expect(socket.sent.last?["params"] == .object(["cwd": .string("/selected")]))
    let report: JSONValue = .object(["project": .string("/selected"), "findings": .array([])])
    socket.answer(report)
    #expect(await until { first.exitStatus != nil })
    #expect(first.exitStatus == 0 && finishes == 1)
    #expect(try JSONDecoder().decode(JSONValue.self, from: first.stdout) == report)
    #expect(center.latest(for: "onboarding")?.id == first.id && center.active(for: "onboarding") == nil)
    #expect(center.presented == nil)

    let failed = try #require(center.run("Check again", steps: [command], key: "onboarding", present: false))
    #expect(await until { socket.sent.filter { $0["method"] == .string("desktop.doctor.run") }.count == 2 })
    socket.refuse()
    #expect(await until { failed.exitStatus != nil })
    #expect(failed.exitStatus == 1 && failed.logLines.contains { $0.text.contains("refused") })
    #expect(client.isOpen)

    let wrong = ActionCenter(cli: cli) { (client, "/another-home") }
    let refused = try #require(wrong.run("Check", steps: [command], key: "onboarding", present: false))
    #expect(await until { refused.launchError != nil })
    #expect(refused.launchError?.contains("not ready") == true)
    #expect(socket.sent.filter { $0["method"] == .string("desktop.doctor.run") }.count == 2)
  }

  @Test func anUnavailableStopFailsActivityWithoutCLIFallbackAndRunsTheNextStep() async throws {
    let cli = Task { StimCLI(environment: ["PATH": "/usr/bin:/bin"], override: "/usr/bin/true") }
    let center = ActionCenter(cli: cli)
    let stop = StimCommand(["stop"], cwd: "/selected")
    let next = StimCommand([], cwd: "/tmp", program: "true")
    var finishes = 0
    let run = try #require(center.run("Clean up", steps: [stop, next], present: false) { _ in finishes += 1 })
    #expect(await until { run.exitStatus != nil })
    #expect(run.exitStatus == 1 && finishes == 1)
    #expect(run.launchError == nil && center.active(for: "/selected") == nil)
    #expect(run.logLines.contains { $0.text.contains("bundled local stim-server is not ready") })
    #expect(run.logLines.contains { $0.text == "$ true" })
    #expect(center.operations.attentionCount == 1 && center.latest(for: "/selected")?.id == run.id)
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
    let cli = Task {
      StimCLI(environment: ["PATH": "/usr/bin:/bin", "STIM_HOME": root.path], override: "/usr/bin/false")
    }
    let center = ActionCenter(cli: cli)
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

  init(onEvent: @escaping @MainActor (ServerTransportEvent) -> Void) { self.onEvent = onEvent }
  func close() {}
  func send(_ text: String) {
    guard case .object(let message) = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { return }
    sent.append(message)
    if message["method"] == .string("hello") {
      answer(
        .object([
          "protocol": .number(2), "server": .object(["name": .string("Mac"), "version": .string("1"), "stim": .string("1")]),
          "capabilities": .array([.string("read"), .string("control")]), "features": .array([.string("desktop-doctor-run")]),
        ]))
    }
  }
  func answer(_ result: JSONValue) { reply(["id": sent.last!["id"]!, "result": result]) }
  func refuse() {
    reply(["id": sent.last!["id"]!, "error": .object(["code": .string("stim-failed"), "message": .string("refused")])])
  }
  private func reply(_ message: [String: JSONValue]) {
    onEvent(.text(String(decoding: try! JSONEncoder().encode(JSONValue.object(message)), as: UTF8.self)))
  }
}
