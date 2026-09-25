import Testing

@testable import StimKit

@Suite struct WorkspaceMenuItemsTests {
  @Test func workspaceRowOffersStartWhenMetroIsStopped() {
    let items = workspaceMenuItems(for: .workspace(metroRunning: false)).compactMap { $0 }
    #expect(items.contains(.startDevServer))
    #expect(!items.contains(.stopDevServer))
    #expect(items.contains(.reload))
    #expect(items.contains(.showLogs))
    #expect(items.contains(.removeWorktree))
    #expect(!items.contains(.warmWorktree))
  }

  @Test func workspaceRowOffersStopWhenMetroIsRunning() {
    let items = workspaceMenuItems(for: .workspace(metroRunning: true)).compactMap { $0 }
    #expect(items.contains(.stopDevServer))
    #expect(!items.contains(.startDevServer))
  }

  @Test func worktreeRowSkipsServerActionsAndOffersWarm() {
    let items = workspaceMenuItems(for: .worktree).compactMap { $0 }
    #expect(items.contains(.warmWorktree))
    #expect(items.contains(.removeWorktree))
    #expect(!items.contains(.reload))
    #expect(!items.contains(.startDevServer))
    #expect(!items.contains(.stopDevServer))
    #expect(!items.contains(.showLogs))
    #expect(!items.contains(.lastOutput))
  }

  @Test func projectRowOnlyOffersFileActionsAndStopAll() {
    let items = workspaceMenuItems(for: .project).compactMap { $0 }
    #expect(items == [.revealInFinder, .copyPath, .stopAllLiveWorkspaces])
  }
}

@Suite struct WorktreeRemovalAllowedTests {
  @Test func allowsRemovalWithNoGitInfo() {
    #expect(worktreeRemovalAllowed(git: nil))
  }

  @Test func allowsRemovalWhenCleanAndPushed() {
    let git = WorktreeGit(changed: 0, untracked: 0, ahead: 0)
    #expect(worktreeRemovalAllowed(git: git))
  }

  @Test func blocksRemovalWithUncommittedChanges() {
    let git = WorktreeGit(changed: 1, untracked: 0)
    #expect(!worktreeRemovalAllowed(git: git))
  }

  @Test func blocksRemovalWithUnpushedCommits() {
    let git = WorktreeGit(changed: 0, untracked: 0, ahead: 2)
    #expect(!worktreeRemovalAllowed(git: git))
  }
}
