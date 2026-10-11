public enum TutorialAnchorID: Hashable, Sendable {
  case sidebarRow, workspaceNoticeShow, deviceControl, viewerScreen, logsToggle, agentActions, replay, archivedFilter
}

public struct TutorialGlowTarget: Equatable, Sendable {
  public var anchor: TutorialAnchorID
  public var callout: String

  public init(_ anchor: TutorialAnchorID, _ callout: String) {
    self.anchor = anchor
    self.callout = callout
  }
}

public enum TutorialGlowPath {
  /// The hops toward the control a step needs, most specific first; the first one on screen glows. `onPage` is whether
  /// a tutorial worktree's page is selected and `logsShown` whether its Logs drawer is open.
  public static func targets(step: String?, ticks: [TutorialTick], onPage: Bool, logsShown: Bool) -> [TutorialGlowTarget] {
    let row = TutorialGlowTarget(.sidebarRow, "Select a tutorial worktree")
    func toward(_ targets: [TutorialGlowTarget]) -> [TutorialGlowTarget] { onPage ? targets : targets + [row] }
    switch step {
    case "build": return [TutorialGlowTarget(.workspaceNoticeShow, "Click Show to watch the build")]
    case "parallel": return [TutorialGlowTarget(.workspaceNoticeShow, "Click Show to watch the first build")]
    case "device":
      return [TutorialGlowTarget(.viewerScreen, "Tap the Tap me button and watch the counter")]
        + toward([TutorialGlowTarget(.deviceControl, "Open the live view")])
    case "agent":
      let viewed = ticks.contains { $0.id == "viewed" && $0.done }
      return [
        viewed
          ? TutorialGlowTarget(.replay, "Press Play to replay it") : TutorialGlowTarget(.agentActions, "See what your agent did")
      ] + toward([TutorialGlowTarget(.deviceControl, "Open the live view")])
    case "logs":
      if !onPage { return [row] }
      return logsShown ? [] : [TutorialGlowTarget(.logsToggle, "Show Logs")]
    case "finish", "done": return [TutorialGlowTarget(.archivedFilter, "Find the run in Archived")]
    default: return []
    }
  }
}
