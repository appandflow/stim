import Foundation
import Testing

@testable import StimKit

@Suite struct ListedWorkspaceTests {
  @Test func stoppedWorkspacesAndWorktreeRootsRemainListedButRemovedPathsDoNot() throws {
    let payload = try JSONDecoder().decode(
      StatusPayload.self,
      from: Data(
        """
        {
          "environments":[{"path":"/w/app","live":false,"warnings":[],"worktree":{"path":"/w"}}],
          "unprovisionedWorktrees":[{"path":"/unprovisioned"}]
        }
        """.utf8))

    #expect(payload.lists(workspace: "/w/app"))
    #expect(payload.lists(workspace: "/w"))
    #expect(payload.lists(workspace: "/unprovisioned"))
    #expect(!payload.lists(workspace: "/removed"))
  }
}
