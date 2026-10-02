import Foundation
import StimKit
import Testing

@testable import StimStores

@MainActor
struct ActionCenterTests {
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
