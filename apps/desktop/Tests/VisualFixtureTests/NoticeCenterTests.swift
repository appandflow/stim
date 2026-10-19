import StimKit
import XCTest

@testable import StimDesktop

@MainActor final class NoticeCenterTests: XCTestCase {
  func testNewWorkspaceCardsExpireIncludingQueuedCardsWithoutDismissingOtherNotices() async throws {
    let center = NoticeCenter(workspaceLifetime: 0.05)
    var dismissals = 0
    let update = Notice(icon: "bell", title: "stim available", actionTitle: "Update", perform: {})
    center.show(update)
    for path in ["/first", "/second"] {
      center.show(
        Notice(
          icon: "folder", title: "New workspace", actionTitle: "Show", perform: {},
          onDismiss: { dismissals += 1 }, key: WorkspaceArrivals.cardKey(path), workspacePath: path))
    }
    center.step(1)

    let deadline = Date().addingTimeInterval(5)
    while center.notices.count > 1 && Date() < deadline {
      try await Task.sleep(for: .milliseconds(20))
    }

    XCTAssertEqual(center.notices.map(\.id), [update.id])
    XCTAssertEqual(center.current?.id, update.id)
    XCTAssertEqual(dismissals, 0)
  }

  func testDismissAllIncludesQueuedNoticesAndRunsEachDismissalOnce() {
    let center = NoticeCenter()
    var dismissals: [Int] = []
    for index in 0..<5 {
      center.show(
        Notice(
          icon: "bell", title: "Notice \(index)", actionTitle: "Show", perform: {},
          onDismiss: { dismissals.append(index) }))
    }
    center.step(2)

    center.dismissAll()
    center.dismissAll()

    XCTAssertTrue(center.notices.isEmpty)
    XCTAssertNil(center.current)
    XCTAssertEqual(dismissals, [4, 3, 2, 1, 0])
  }

  func testRemovedWorkspaceNoticesLeaveWithoutRecordingAUserDismissal() throws {
    let payload = try JSONDecoder().decode(
      StatusPayload.self,
      from: Data(
        #"{"environments":[{"path":"/stopped","live":false,"warnings":[]}]}"#.utf8))
    let center = NoticeCenter()
    var dismissals = 0
    let update = Notice(icon: "bell", title: "stim available", actionTitle: "Update", perform: {})
    let stopped = Notice(
      icon: "iphone", title: "Stopped workspace", actionTitle: "Show", perform: {}, workspacePath: "/stopped")
    let removed = Notice(
      icon: "iphone", title: "Removed workspace", actionTitle: "Show", perform: {},
      onDismiss: { dismissals += 1 }, workspacePath: "/removed")
    let otherRemoved = Notice(
      icon: "iphone", title: "Other removed workspace", actionTitle: "Show", perform: {}, workspacePath: "/other-removed")
    for notice in [update, stopped, removed, otherRemoved] { center.show(notice) }
    center.step(2)

    center.dismissCards(notIn: payload)

    XCTAssertEqual(center.notices.map(\.id), [stopped.id, update.id])
    XCTAssertEqual(center.current?.id, stopped.id)
    XCTAssertEqual(dismissals, 0)
  }
}
