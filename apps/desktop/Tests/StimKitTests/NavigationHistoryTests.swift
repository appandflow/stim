import Testing

@testable import StimKit

struct NavigationHistoryTests {
  private func history(_ pushes: String...) -> NavigationHistory<String> {
    var history = NavigationHistory(current: "overview")
    for destination in pushes { history.push(destination) }
    return history
  }

  @Test func backAndForwardMoveThroughPushedDestinations() {
    var history = history("project", "workspace")
    #expect(history.current == "workspace")
    #expect(history.goBack() == "project")
    #expect(history.goBack() == "overview")
    #expect(history.goBack() == nil)
    #expect(history.goForward() == "project")
    #expect(history.current == "project")
  }

  @Test func atTheEndsThereIsNothingToGoTo() {
    var history = history("project")
    #expect(!history.canGoForward())
    #expect(history.goForward() == nil)
    #expect(history.canGoBack())
    _ = history.goBack()
    #expect(!history.canGoBack())
    #expect(history.canGoForward())
  }

  @Test func pushingAfterGoingBackDropsTheForwardEntries() {
    var history = history("project", "workspace")
    _ = history.goBack()
    history.push("notifications")
    #expect(history.entries == ["overview", "project", "notifications"])
    #expect(!history.canGoForward())
    #expect(history.goBack() == "project")
  }

  @Test func pushingTheCurrentDestinationKeepsTheForwardEntries() {
    var history = history("project", "workspace")
    _ = history.goBack()
    history.push("project")
    #expect(history.entries == ["overview", "project", "workspace"])
    #expect(history.canGoForward())
  }

  @Test func theCapDropsTheOldestEntries() {
    var history = NavigationHistory(current: 0, limit: 3)
    for destination in 1...5 { history.push(destination) }
    #expect(history.entries == [3, 4, 5])
    #expect(history.current == 5)
    #expect(history.goBack() == 4)
    #expect(history.goBack() == 3)
    #expect(history.goBack() == nil)
  }

  @Test func backSkipsDestinationsThatNoLongerResolve() {
    var history = history("project", "gone", "workspace")
    let resolves: (String) -> Bool = { $0 != "gone" }
    #expect(history.canGoBack(where: resolves))
    #expect(history.goBack(where: resolves) == "project")
    #expect(history.canGoForward(where: resolves))
    #expect(history.goForward(where: resolves) == "workspace")
  }

  @Test func nothingToGoToWhenEveryEarlierEntryIsGone() {
    var history = history("gone", "workspace")
    let resolves: (String) -> Bool = { $0 == "workspace" }
    #expect(!history.canGoBack(where: resolves))
    #expect(history.goBack(where: resolves) == nil)
    #expect(history.current == "workspace")
  }

  @Test func backSkipsEntriesEqualToTheCurrentDestination() {
    var history = history("project", "gone", "project")
    #expect(history.entries == ["overview", "project", "gone", "project"])
    #expect(history.goBack(where: { $0 != "gone" }) == "overview")
  }

  @Test func replacingTheCurrentDestinationKeepsTheStack() {
    var history = history("project")
    history.replaceCurrent("other")
    #expect(history.entries == ["overview", "other"])
  }
}
