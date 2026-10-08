import Foundation
import Testing

@testable import StimKit

struct AttentionNoticesTests {
  private func item(
    _ id: String, _ category: NeedsAttentionItem.Category = .attention, remedy: String? = nil
  ) -> NeedsAttentionItem {
    NeedsAttentionItem(
      id: id, category: category, severity: "warning", workspace: "/a", body: "body \(id)", remedy: remedy)
  }

  private func update(
    _ previous: Set<String>, _ items: [NeedsAttentionItem], kept: [PullRequestCleanup.Flag] = [],
    pending: @escaping (String) -> Bool = { _ in false }
  ) -> AttentionNotices.Result {
    AttentionNotices.update(
      previous: previous, items: items, kept: kept, machine: "Mac", title: { "title of \($0)" }, pending: pending)
  }

  @Test func notifiesOncePerEpisodeAndAgainAfterTheItemWentAway() {
    let first = update([], [item("lease")])
    #expect(first.notifications.map(\.id) == ["lease"])
    let still = update(first.active, [item("lease")])
    #expect(still.notifications.isEmpty)
    let gone = update(still.active, [])
    #expect(gone.active.isEmpty)
    #expect(update(gone.active, [item("lease")]).notifications.map(\.id) == ["lease"])
  }

  @Test func leavesStuckLoopingAndMachineItemsToTheirOwnCategories() {
    let result = update([], [item("stuck:/a", .stuck), item("looping-ios:/a", .looping), item("machine:disk", .machine)])
    #expect(result.notifications.isEmpty)
    #expect(result.active.isEmpty)
  }

  @Test func carriesTheRemedyAndTargetsTheBuildOfASigningFailure() {
    let result = update([], [item("run-ios:/a", remedy: nil), item("setup-x:/a", remedy: "stim doctor --fix")])
    #expect(result.notifications[0].target == .build(path: "/a", platform: "ios"))
    #expect(result.notifications[1].remedy == "stim doctor --fix")
    #expect(result.notifications[1].target == .workspace(path: "/a"))
    #expect(result.notifications.allSatisfy { $0.category == .attention && $0.title == "title of /a" })
  }

  @Test func keepsAnIdWhoseSourceHasNotReportedYetSoItDoesNotRepeat() {
    let result = update(["setup-x:/a", "lease"], [], pending: { $0.hasPrefix("setup-") })
    #expect(result.active == ["setup-x:/a"])
  }

  @Test func notifiesAKeptWorktreeWithItsPullRequestAsTheTarget() {
    let flag = PullRequestCleanup.Flag(
      path: "/r/dirty",
      pullRequest: GcReport.PullRequestState(number: 5, state: "merged", url: "https://x/pull/5", containsHead: true),
      text: "PR #5 merged, 2 uncommitted files")
    let result = update([], [], kept: [flag])
    #expect(result.notifications.map(\.id) == ["pr-kept:/r/dirty"])
    #expect(result.notifications[0].target == .url(path: "/r/dirty", url: "https://x/pull/5"))
    #expect(update(result.active, [], kept: [flag]).notifications.isEmpty)
  }

  @Test func readsARemedyAsACommandInTheWorkspace() {
    #expect(remedyCommand("stim doctor --fix", workspace: "/a")?.isFix == true)
    #expect(remedyCommand("stim guide errors teardown", workspace: "/a")?.isRunnable == false)
    #expect(remedyCommand("npm install", workspace: "/a") == nil)
    #expect(remedyCommand("stim stop", workspace: nil) == nil)
  }

  @Test func raisesNothingForAFolderThatIsNotAnApp() {
    let items = setupItems([
      DoctorReport(
        project: "/r",
        findings: [
          .init(
            code: notAnAppFindingCode, level: "cost", title: "This directory is not a React Native or Expo app", detail: "",
            fix: nil),
          .init(code: "ccache", level: "cost", title: "ccache is off", detail: "", fix: nil),
        ])
    ])
    #expect(items.count == 2)
    let result = update([], items)
    #expect(result.notifications.map(\.id) == ["setup-ccache:/r"])
  }

  private func notice(_ id: String, _ path: String) -> OversightNotification {
    OversightNotification(
      id: id, category: .attention, title: "t", body: "b", quiet: true, thread: nil, target: .workspace(path: path))
  }

  @Test func allowsOneAttentionPerWorkspacePerRun() {
    var runs = AttentionRuns()
    func admit(_ ids: [String], live: Set<String>, present: Set<String> = ["/a", "/b"]) -> [String] {
      runs.admit(ids.map { notice($0, $0.hasPrefix("b") ? "/b" : "/a") }, live: live, present: present).map(\.id)
    }
    #expect(admit(["a1", "a2", "b1"], live: ["/a"]) == ["a1", "b1"])
    #expect(admit(["a3"], live: ["/a"]).isEmpty)
    #expect(admit(["a3"], live: []).isEmpty)
    #expect(admit(["a4"], live: ["/a"]) == ["a4"])
    #expect(admit([], live: ["/a"], present: ["/a"]).isEmpty)
    #expect(admit(["b2"], live: ["/a"]) == ["b2"])
  }

  @Test func letsAMachineItemThroughAlways() {
    var runs = AttentionRuns()
    let machine = OversightNotification(
      id: "m", category: .attention, title: "t", body: "b", quiet: true, thread: nil, target: .machine)
    #expect(runs.admit([machine, machine], live: [], present: []).count == 2)
  }
}
