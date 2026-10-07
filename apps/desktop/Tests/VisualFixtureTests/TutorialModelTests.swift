#if DEBUG
  import Foundation
  import StimKit
  import XCTest

  @testable import StimDesktop

  final class TutorialModelTests: XCTestCase {
    @MainActor private func isolatedDefaults() -> UserDefaults {
      let name = "TutorialModelTests.\(UUID())"
      let defaults = UserDefaults(suiteName: name)!
      addTeardownBlock { defaults.removePersistentDomain(forName: name) }
      return defaults
    }

    private func workspace(since: String = "2026-10-07T12:00:00Z") throws -> Workspace {
      try JSONDecoder().decode(
        Workspace.self,
        from: Data(
          """
          {"path":"/tmp/tutorial-tour","live":true,"warnings":[],"tutorial":{"version":1},
           "phase":"ready","phaseSince":"\(since)"}
          """.utf8))
    }

    @MainActor func testAutoOpenWaitsForSheetsAndDoesNotReopenAfterClose() throws {
      let defaults = isolatedDefaults()
      let model = TutorialModel(defaults: defaults)
      let env = try workspace()
      model.update(workspaces: [env], archivedRoots: [], sheetOpen: true)
      XCTAssertFalse(model.isOpen)
      model.update(workspaces: [env], archivedRoots: [], sheetOpen: false)
      XCTAssertTrue(model.isOpen)
      XCTAssertEqual(model.tourPath, env.path)
      model.close()
      model.update(workspaces: [env], archivedRoots: [], sheetOpen: false)
      XCTAssertFalse(model.isOpen)
      TutorialRecordStore(defaults).record = nil
      let anotherLaunch = TutorialModel(defaults: defaults)
      anotherLaunch.update(workspaces: [env], archivedRoots: [], sheetOpen: false)
      XCTAssertFalse(anotherLaunch.isOpen)
      var anotherTour = env
      anotherTour.path = "/tmp/another-tour"
      anotherLaunch.update(workspaces: [anotherTour], archivedRoots: [], sheetOpen: false)
      XCTAssertTrue(anotherLaunch.isOpen)
    }

    @MainActor func testResumeRestoresSkippedStepsAndManualMode() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 1, tourPath: "/tmp/tutorial-tour", startedAt: Date(), step: "build",
        done: ["begin"], skipped: ["sidebar"], manual: true)
      let model = TutorialModel(defaults: defaults)
      model.update(workspaces: [try workspace()], archivedRoots: [], sheetOpen: false)
      XCTAssertTrue(model.isOpen)
      XCTAssertEqual(model.snapshot?.currentStep, "build")
      XCTAssertTrue(model.manual)
      XCTAssertEqual(model.snapshot?.record.skipped, ["sidebar"])
    }

    @MainActor func testResumeArchivedTourShowsDone() {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 1, tourPath: "/tmp/tutorial-tour", startedAt: Date(), step: "finish")
      let model = TutorialModel(defaults: defaults)
      model.update(workspaces: [], archivedRoots: ["/tmp/tutorial-tour"], sheetOpen: false)
      XCTAssertTrue(model.isOpen)
      XCTAssertTrue(model.snapshot?.isComplete == true)
    }

    @MainActor func testRestartResetsOnlyForNewerWorkspace() throws {
      let defaults = isolatedDefaults()
      let start = ISO8601DateFormatter().date(from: "2026-10-07T12:00:00Z")!
      let model = TutorialModel(defaults: defaults)
      let env = try workspace()
      model.update(workspaces: [env], archivedRoots: [], sheetOpen: false, now: start)
      model.skip()
      model.setManual(true)
      model.restart(now: start.addingTimeInterval(30))
      model.update(workspaces: [env], archivedRoots: [], sheetOpen: false, now: start.addingTimeInterval(31))
      XCTAssertTrue(model.restarting)
      XCTAssertTrue(model.manual)
      model.update(
        workspaces: [try workspace(since: "2026-10-07T12:01:00Z")], archivedRoots: [], sheetOpen: false,
        now: start.addingTimeInterval(61))
      XCTAssertFalse(model.restarting)
      XCTAssertFalse(model.manual)
      XCTAssertEqual(model.snapshot?.record.skipped, [])
      XCTAssertEqual(model.snapshot?.currentStep, "sidebar")
    }

    @MainActor func testWaitingTimeoutStartsWhenPromptIsCopied() {
      let model = TutorialModel(defaults: isolatedDefaults())
      model.open()
      let now = Date()
      model.update(workspaces: [], archivedRoots: [], sheetOpen: false, now: now.addingTimeInterval(300))
      XCTAssertEqual(model.message, "Waiting for the tutorial workspace...")
      model.copiedPrompt(now: now.addingTimeInterval(300))
      model.update(workspaces: [], archivedRoots: [], sheetOpen: false, now: now.addingTimeInterval(481))
      XCTAssertEqual(model.message, "No tutorial workspace yet. Ask your agent what failed")
    }

    @MainActor func testOldViewerEventsCannotCompleteANewTourOnAReusedDevice() throws {
      let env = try JSONDecoder().decode(
        Workspace.self,
        from: Data(
          """
          {"path":"/tmp/new-tour","live":true,"warnings":[],"tutorial":{"version":1},"phase":"ready",
           "ios":{"udid":"reused-simulator","state":"Booted","owned":true,"app":{"id":"dev.stim.tutorial","state":"running"}}}
          """.utf8))
      let previous: [TutorialViewerEvent] = [.opened("reused-simulator"), .input("reused-simulator")]
      let model = TutorialModel(defaults: isolatedDefaults())
      model.update(workspaces: [env], archivedRoots: [], sheetOpen: false, viewerEvents: previous)
      for _ in 0..<3 { model.skip() }
      XCTAssertEqual(model.snapshot?.currentStep, "device")
      model.update(workspaces: [env], archivedRoots: [], sheetOpen: false, viewerEvents: previous)
      XCTAssertEqual(model.snapshot?.currentStep, "device")
      model.update(workspaces: [env], archivedRoots: [], sheetOpen: false, viewerEvents: previous + previous)
      XCTAssertEqual(model.snapshot?.currentStep, "logs")
    }

    @MainActor func testSetupEntryBeginsWhileHelpResumes() {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 1, startedAt: Date(), step: "build", done: ["begin", "sidebar"], manual: true)
      let model = TutorialModel(defaults: defaults)
      model.open()
      XCTAssertEqual(model.snapshot?.currentStep, "build")
      model.open(beginning: true)
      XCTAssertEqual(model.snapshot?.currentStep, "begin")
      XCTAssertEqual(model.prompt, "Run the Stim tutorial.")
      XCTAssertFalse(model.manual)
    }

    @MainActor func testDeletedWorkspaceRequiresRestartWithoutObservedStop() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 1, tourPath: "/tmp/tutorial-tour", startedAt: Date(), step: "finish",
        done: TutorialSteps.all.dropLast().map(\.id))
      let model = TutorialModel(defaults: defaults)
      model.update(workspaces: [try workspace()], archivedRoots: [], sheetOpen: false)
      let now = Date()
      model.update(workspaces: [], archivedRoots: [], sheetOpen: false, now: now)
      model.update(workspaces: [], archivedRoots: [], sheetOpen: false, now: now.addingTimeInterval(30))
      XCTAssertFalse(model.snapshot?.isComplete == true)
      XCTAssertEqual(model.message, "Tutorial workspace gone: Restart")
    }

    @MainActor func testFinishWithoutArchiveWaitsForGraceAndObservedStop() throws {
      let defaults = isolatedDefaults()
      var record = TutorialRecord(
        version: 1, tourPath: "/tmp/tutorial-tour", startedAt: Date(), step: "finish",
        done: TutorialSteps.all.dropLast().map(\.id))
      record.stopped = true
      TutorialRecordStore(defaults).record = record
      let model = TutorialModel(defaults: defaults)
      model.update(workspaces: [try workspace()], archivedRoots: [], sheetOpen: false)
      let now = Date()
      model.update(workspaces: [], archivedRoots: [], sheetOpen: false, now: now)
      XCTAssertFalse(model.snapshot?.isComplete == true)
      model.update(workspaces: [], archivedRoots: [], sheetOpen: false, now: now.addingTimeInterval(11))
      XCTAssertTrue(model.snapshot?.isComplete == true)
    }
  }
#endif
