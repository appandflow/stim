import XCTest

@testable import StimKit

final class TutorialCleanupTests: XCTestCase {
  func testFailedServerStopPreservesTheTutorialFolderBeforeRemoval() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tutorial-stop-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let stopped = LockedValue([String]())
    let cleanup = TutorialCleanup(
      stop: { path in
        stopped.withLock { $0.append(path) }
        throw CommandFailure.exited(7, stderr: "Server stop refused")
      }, removeWorktree: { _, _ in XCTFail("Removal must not start after stop fails") })
    do {
      try await cleanup.remove(base: dir.path, worktrees: [])
      XCTFail("Removal must stop after the server refuses teardown")
    } catch CommandFailure.exited(let status, let stderr) {
      XCTAssertEqual(status, 7)
      XCTAssertEqual(stderr, "Server stop refused")
    }
    XCTAssertEqual(stopped.withLock { $0 }, [dir.path])
    XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path))
  }

  func testFailedServerRemovalPreservesCloneAndStopsBeforeTheNextWorkspace() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tutorial-remove-\(UUID().uuidString)")
    let linked = dir.appendingPathComponent("linked")
    try FileManager.default.createDirectory(at: linked, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let steps = LockedValue([String]())
    let cleanup = TutorialCleanup(
      stop: { path in steps.withLock { $0.append("stop " + path) } },
      removeWorktree: { path, base in
        steps.withLock { $0.append("remove " + path + " from " + base) }
        throw CommandFailure.exited(1, stderr: "Branch cleanup failed")
      })
    do {
      try await cleanup.remove(base: dir.path, worktrees: [linked.path])
      XCTFail("Removal failure must preserve the tutorial clone")
    } catch CommandFailure.exited(let status, let stderr) {
      XCTAssertEqual(status, 1)
      XCTAssertEqual(stderr, "Branch cleanup failed")
    }
    XCTAssertEqual(steps.withLock { $0 }, ["stop " + linked.path, "remove " + linked.path + " from " + dir.path])
    XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path))
  }

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
