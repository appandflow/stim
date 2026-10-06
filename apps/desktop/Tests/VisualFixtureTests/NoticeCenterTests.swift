import StimKit
import XCTest

@testable import StimDesktop

@MainActor final class NoticeCenterTests: XCTestCase {
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
