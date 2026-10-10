import XCTest

@testable import StimKit

final class TutorialCleanupTests: XCTestCase {
  func testMarkedFolderIsRemovedWithItsWorktrees() {
    XCTAssertEqual(
      tutorialCleanupPlan(base: "/b", hasMarker: true, linkedWorktrees: ["/t", "/s"]), .remove(worktrees: ["/t", "/s"]))
  }

  func testFolderWithoutMarkerIsRefused() {
    guard case .refuse(let reason) = tutorialCleanupPlan(base: "/b", hasMarker: false, linkedWorktrees: ["/t"]) else {
      return XCTFail("removed")
    }
    XCTAssertTrue(reason.contains("/b"))
  }

  func testMarkerComesFromAppJSON() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    XCTAssertFalse(TutorialCleanup.hasMarker(at: dir.path))
    try Data(#"{"expo":{"extra":{"stimTutorial":1}}}"#.utf8).write(to: dir.appendingPathComponent("app.json"))
    XCTAssertTrue(TutorialCleanup.hasMarker(at: dir.path))
  }
}
