import Foundation
import StimKit
import Testing

struct DoctorTests {
  @Test func listsCostFindingsAsSetupItemsWithTheirStimRemedy() throws {
    let url = try #require(Bundle.module.url(forResource: "doctor", withExtension: "json", subdirectory: "Fixtures"))
    let report = try JSONDecoder().decode(DoctorReport.self, from: Data(contentsOf: url))
    let items = setupItems([report])
    #expect(items.map(\.body) == [
      "Setup: Host memory pressure can stall the iOS simulator",
      "Setup: The configured CMake cache predates the ccache launcher, so C++ compiles still bypass it",
    ])
    #expect(items.map(\.remedy) == ["stim guide lifecycle simslim", "stim doctor --fix --platform android"])
    #expect(items.map(\.runnable) == [false, true])
    #expect(items.allSatisfy { $0.workspace == "/Users/dev/stim/apps/mobile" && $0.category == .attention })
  }

  @Test func takesTheFirstBacktickedStimCommandOnly() {
    #expect(doctorRemedy("Run `npx expo config --json`, then `stim doctor`.") == "stim doctor")
    #expect(doctorRemedy("Free host memory, then retry.") == nil)
    #expect(doctorRemedy(nil) == nil)
  }

  @Test func runsInTheListedSourceCheckoutElseTheFirstWorktreeOfTheApp() throws {
    let envs = try JSONDecoder().decode(
      [Workspace].self,
      from: Data(
        #"""
        [{"path":"/r/.worktrees/a/apps/m","live":false,"warnings":[],"worktree":{"path":"/r/.worktrees/a"}},
         {"path":"/r/.worktrees/b/apps/m","live":false,"warnings":[],"worktree":{"path":"/r/.worktrees/b"}},
         {"path":"/r/apps/m","live":false,"warnings":[],"worktree":{"path":"/r"}},
         {"path":"/r/.worktrees/a/apps/w","live":false,"warnings":[],"worktree":{"path":"/r/.worktrees/a"}},
         {"path":"/solo","live":false,"warnings":[]}]
        """#.utf8))
    let checkouts = doctorCheckouts(envs) { $0 == "/solo" ? Project(root: "/solo") : Project(root: "/r") }
    #expect(checkouts.map(\.path) == ["/r/apps/m", "/r/.worktrees/a/apps/w", "/solo"])
    #expect(checkouts.map(\.repository) == ["/r", "/r", "/solo"])
  }

  @Test func isDueWhenNeverRunNewStimOldRunOrChangedSetup() {
    let now = Date(timeIntervalSince1970: 1_000_000)
    let inputs = now.addingTimeInterval(-3600)
    let last = DoctorRun(at: now.addingTimeInterval(-60), version: "1.12.0", inputsChangedAt: inputs)
    #expect(DoctorRun.due(nil, version: "1.12.0", inputsChangedAt: inputs, now: now))
    #expect(!DoctorRun.due(last, version: "1.12.0", inputsChangedAt: inputs, now: now))
    #expect(DoctorRun.due(last, version: "1.13.0", inputsChangedAt: inputs, now: now))
    #expect(DoctorRun.due(last, version: "1.12.0", inputsChangedAt: now, now: now))
    #expect(DoctorRun.due(last, version: "1.12.0", inputsChangedAt: inputs, now: now.addingTimeInterval(8 * 86_400)))
  }
}
