import Foundation
import Testing

@testable import StimKit

@Suite struct GcSummaryTests {
  private func fixture(_ name: String) throws -> GcOutcome {
    let url = try #require(Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: nil))
    return try GcOutcome(json: Data(contentsOf: url))
  }

  private func title(_ path: String) -> String { PathNames(path: path).title }

  @Test func realDryRunOutputHasNothingToSummarize() throws {
    #expect(try fixture("gc-dry-run.json").summary(name: title) == "Nothing to clean up.")
  }

  @Test func realDeleteOutputNamesPrunedWorkspacesByFolder() throws {
    #expect(
      try fixture("gc-delete-projects.json").summary(name: title) == "Pruned 2 workspaces: alpha, beta.")
  }

  @Test func namesWhatARunFreedArchivedAndDeleted() throws {
    let json = """
      {"mode":"delete","failures":0,"sections":{},"results":[
        {"kind":"worktree","status":"done","label":"/r/.worktrees/x","id":null,"bytes":null,"detail":"merged"},
        {"kind":"worktree","status":"done","label":"/r/.worktrees/y","id":null,"bytes":null,"detail":"merged"},
        {"kind":"worktree","status":"kept","label":"/r/.worktrees/dirty","id":null,"bytes":null,"detail":"dirty"},
        {"kind":"device","status":"done","label":"stim-a (iPhone 18 Pro 27.0)","id":"U1","bytes":null,"detail":null},
        {"kind":"workspaceOutputs","status":"done","label":"/p/app","id":null,"bytes":3800000000,"detail":null}
      ]}
      """
    let outcome = try GcOutcome(json: Data(json.utf8))
    let names = ["/r/.worktrees/x": "feat/x"]
    #expect(
      outcome.summary(name: { names[$0] ?? PathNames(path: $0).title })
        == "Freed 3.8 GB. Archived 2 removed worktrees: feat/x, y. Deleted 1 device. Cleared build outputs of 1 workspace.")
    #expect(outcome.archivedWorktrees.count == 2)
  }

  @Test func capsNamesAtThreeWithAMoreCountAndReportsFailures() throws {
    let rows = (1...5).map {
      "{\"kind\":\"worktree\",\"status\":\"done\",\"label\":\"/r/.worktrees/w\($0)\",\"id\":null,\"bytes\":null,\"detail\":null}"
    }
    let failed =
      "{\"kind\":\"cache\",\"status\":\"failed\",\"label\":\"Build cache\",\"id\":\"/c\",\"bytes\":null,\"detail\":\"x\"}"
    let json = "{\"mode\":\"delete\",\"failures\":1,\"sections\":{},\"results\":[\(rows.joined(separator: ",")),\(failed)]}"
    let outcome = try GcOutcome(json: Data(json.utf8))
    #expect(outcome.summary(name: title) == "Archived 5 removed worktrees: w1, w2, w3, +2 more. 1 failed.")
  }
}
