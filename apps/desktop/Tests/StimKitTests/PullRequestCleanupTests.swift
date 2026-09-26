import Foundation
import Testing

@testable import StimKit

@Suite struct PullRequestCleanupTests {
  func report() throws -> GcReport {
    let json = """
      {"sections":{"linkedWorktrees":[
        {"path":"/r/shipped","mergedInto":null,"willRemove":true,"reason":null,"detail":"PR #1 merged",
         "pullRequest":{"number":1,"state":"merged","url":"https://github.com/o/r/pull/1","containsHead":true}},
        {"path":"/r/abandoned","mergedInto":null,"willRemove":true,"reason":null,"detail":"PR #2 closed",
         "pullRequest":{"number":2,"state":"closed","url":"https://github.com/o/r/pull/2","containsHead":true}},
        {"path":"/r/git-merged","mergedInto":"origin/main","willRemove":true,"reason":null,"detail":"merged into origin/main",
         "pullRequest":null},
        {"path":"/r/idle","mergedInto":null,"willRemove":true,"reason":null,"detail":"idle 9d",
         "pullRequest":{"number":5,"state":"open","url":"https://github.com/o/r/pull/5","containsHead":true}},
        {"path":"/r/dirty","mergedInto":null,"willRemove":false,"reason":"dirty",
         "detail":"dirty: 2 uncommitted or untracked files",
         "pullRequest":{"number":123,"state":"merged","url":"https://github.com/o/r/pull/123","containsHead":true}},
        {"path":"/r/local","mergedInto":null,"willRemove":false,"reason":"unpushed",
         "detail":"unpushed: 1 commit on no remote or other branch",
         "pullRequest":{"number":7,"state":"closed","url":"https://github.com/o/r/pull/7","containsHead":true}},
        {"path":"/r/fresh","mergedInto":null,"willRemove":false,"reason":"recent-activity",
         "detail":"recent activity: PR #8 merged 5m ago; removable after 2026-09-25T14:00:00.000Z",
         "eligibleAt":"2026-09-25T14:00:00.000Z",
         "pullRequest":{"number":8,"state":"merged","url":"https://github.com/o/r/pull/8","containsHead":true}}
      ]}}
      """
    return try JSONDecoder().decode(GcReport.self, from: Data(json.utf8))
  }

  /// Catches the autopilot removing a worktree gc keeps, or one it removes for another reason (idle, git merge).
  @Test func removesOnlyWhatGcFindsSafeBecauseItsPullRequestFinished() throws {
    #expect(PullRequestCleanup.removable(try report()).map(\.path) == ["/r/shipped", "/r/abandoned"])
  }

  /// Catches an unsafe worktree with a finished pull request going unmentioned, or one that only waits out the
  /// grace period being flagged as needing a person.
  @Test func flagsKeptWorktreesWithTheirReason() throws {
    let flags = PullRequestCleanup.flagged(try report())
    #expect(
      flags.map(\.text) == [
        "PR #123 merged, 2 uncommitted or untracked files", "PR #7 closed, 1 commit on no remote or other branch",
      ])
    #expect(PullRequestCleanup.nextEligible(try report()) == ISO8601DateFormatter().date(from: "2026-09-25T14:00:00Z"))
  }

  /// Catches the Storage count reading 0 while gc removes worktrees whose pull request finished.
  @Test func storageCountsWorktreesOfFinishedPullRequests() throws {
    #expect(try report().mergedWorktrees.map(\.path) == ["/r/shipped", "/r/abandoned", "/r/git-merged"])
  }

  /// Catches the main checkout, or a worktree of another repository with the same branch name, triggering gc.
  @Test func candidatesAreLinkedWorktreesOnAFinishedBranchOfTheirRepository() throws {
    let json = """
      [{"path":"/r","live":false,"warnings":[],"worktree":{"path":"/r","branch":"done","repository":"/r"}},
       {"path":"/r/wt/app","live":false,"warnings":[],"worktree":{"path":"/r/wt","branch":"done","repository":"/r"}},
       {"path":"/other/wt","live":false,"warnings":[],"worktree":{"path":"/other/wt","branch":"done","repository":"/other"}},
       {"path":"/r/detached","live":false,"warnings":[],"worktree":{"path":"/r/detached","repository":"/r"}}]
      """
    let environments = try JSONDecoder().decode([Workspace].self, from: Data(json.utf8))
    let finished = try #require(PullRequestCleanup.branches(Data(#"[{"headRefName":"done"}]"#.utf8)))
    #expect(PullRequestCleanup.candidates(environments, finished: ["/r": finished]) == ["/r/wt"])
  }

  @Test func summaryNamesWhatFinished() throws {
    let removable = PullRequestCleanup.removable(try report())
    #expect(PullRequestCleanup.summary(removable) == "Removed 2 worktrees for merged or closed PRs")
    #expect(PullRequestCleanup.summary(Array(removable.prefix(1))) == "Removed 1 worktree for merged PRs")
  }
}
