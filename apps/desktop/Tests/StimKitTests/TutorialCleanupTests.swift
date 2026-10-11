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
    try Data(#"{"expo":{"extra":{"stimTutorial":2}}}"#.utf8).write(to: dir.appendingPathComponent("app.json"))
    XCTAssertTrue(TutorialCleanup.hasMarker(at: dir.path))
  }

  func testWorktreePathsKeepsTheCloneFirstAndTheLinkedOnesAfter() {
    let porcelain = "worktree /a/base\nHEAD 1\nbranch refs/heads/main\n\nworktree /a/tour\nHEAD 1\n\nworktree /a/second\nHEAD 1\n"
    XCTAssertEqual(TutorialCleanup.worktreePaths(porcelain), ["/a/base", "/a/tour", "/a/second"])
  }

  func testFolderMovesToTheTrashAndStaysRecoverable() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("stim-tutorial-trash-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try Data("x".utf8).write(to: dir.appendingPathComponent("file"))
    try TutorialCleanup.moveToTrash(dir.path)
    let inTrash = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".Trash/" + dir.lastPathComponent)
    defer { try? FileManager.default.removeItem(at: inTrash) }
    XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: inTrash.appendingPathComponent("file").path))
  }
}
