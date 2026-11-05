import Testing

@testable import StimKit

private func anchors(_ step: String, viewed: Bool = false, onPage: Bool, logsShown: Bool = false) -> [TutorialAnchorID] {
  TutorialGlowPath.targets(
    step: step, ticks: [TutorialTick(id: "viewed", done: viewed, optional: false)], onPage: onPage, logsShown: logsShown
  ).map(\.anchor)
}

@Test func tutorialGlowLeadsFromTheSidebarRowOnlyWhenTheUserIsOffTheTutorialPage() {
  #expect(anchors("agent", onPage: false) == [.agentActions, .deviceControl, .sidebarRow])
  #expect(anchors("agent", onPage: true) == [.agentActions, .deviceControl])
  #expect(anchors("agent", viewed: true, onPage: true) == [.replay, .deviceControl])
  #expect(anchors("device", onPage: false) == [.viewerScreen, .deviceControl, .sidebarRow])
  #expect(anchors("device", onPage: true) == [.viewerScreen, .deviceControl])
}

@Test func tutorialLogsGlowGoesFromTheSidebarRowToTheToolbarToggleAndStopsOnceLogsShow() {
  #expect(anchors("logs", onPage: false) == [.sidebarRow])
  #expect(anchors("logs", onPage: true) == [.logsToggle])
  #expect(anchors("logs", onPage: true, logsShown: true).isEmpty)
}
