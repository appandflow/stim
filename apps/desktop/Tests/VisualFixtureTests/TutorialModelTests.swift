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

    private func archive() throws -> ArchivedWorkspace {
      try JSONDecoder().decode(
        ArchivedWorkspace.self,
        from: Data(
          """
          {"id":"tour-archive","projectRoot":"/tmp/tutorial-tour","project":"tutorial","workspace":"tour",
           "worktree":{},"removedAt":"2026-10-07T12:01:00Z","removedBy":"worktree-remove",
           "builds":{},"agents":[],"bytes":{"logs":0,"recordings":0,"agentActions":0,"record":0,"total":0},
           "expires":{},"version":1}
          """.utf8))
    }

    @MainActor func testAutoOpenWaitsForSheetsAndDoesNotReopenAfterClose() throws {
      let defaults = isolatedDefaults()
      let model = TutorialModel(defaults: defaults)
      let env = try workspace()
      model.update(workspaces: [env], archived: [], sheetOpen: true)
      XCTAssertFalse(model.isOpen)
      model.update(workspaces: [env], archived: [], sheetOpen: false)
      XCTAssertTrue(model.isOpen)
      XCTAssertEqual(model.tourPath, env.path)
      model.close()
      model.update(workspaces: [env], archived: [], sheetOpen: false)
      XCTAssertFalse(model.isOpen)
      TutorialRecordStore(defaults).record = nil
      let anotherLaunch = TutorialModel(defaults: defaults)
      anotherLaunch.update(workspaces: [env], archived: [], sheetOpen: false)
      XCTAssertFalse(anotherLaunch.isOpen)
      var anotherTour = env
      anotherTour.path = "/tmp/another-tour"
      anotherLaunch.update(workspaces: [anotherTour], archived: [], sheetOpen: false)
      XCTAssertTrue(anotherLaunch.isOpen)
    }

    @MainActor func testResumeRestoresSkippedStepsAndManualMode() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 1, tourPath: "/tmp/tutorial-tour", startedAt: Date(), step: "build",
        done: ["begin"], skipped: ["sidebar"], manual: true)
      let model = TutorialModel(defaults: defaults)
      model.update(workspaces: [try workspace()], archived: [], sheetOpen: false)
      XCTAssertTrue(model.isOpen)
      XCTAssertEqual(model.snapshot?.currentStep, "build")
      XCTAssertTrue(model.manual)
      XCTAssertEqual(model.snapshot?.record.skipped, ["sidebar"])
    }

    @MainActor func testMachineApprovalAdvancesAndSurvivesLocalRefresh() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 1, tourPath: "/tmp/tutorial-tour", startedAt: Date(), step: "machine",
        done: TutorialSteps.all.prefix { $0.id != "machine" }.map(\.id))
      let model = TutorialModel(defaults: defaults)
      let env = try workspace()
      model.update(workspaces: [env], archived: [], sheetOpen: false, machineState: .awaitingApproval)
      XCTAssertEqual(model.snapshot?.currentStep, "machine")
      XCTAssertFalse(model.machineState.showsPrompt)
      model.update(workspaces: [env], archived: [], sheetOpen: false, machineState: .approved, approvedMachine: "Studio")
      XCTAssertEqual(model.snapshot?.currentStep, "finish")
      XCTAssertTrue(model.machineState.showsPrompt)
      model.setManual(true)
      XCTAssertEqual(model.machineState, .approved)
      let step = try XCTUnwrap(TutorialSteps.all.first { $0.id == "machine" })
      XCTAssertTrue(model.commands(for: step).contains("--build-machine \"Studio\""))
      model.update(workspaces: [env], archived: [], sheetOpen: false, machineState: .awaitingApproval)
      XCTAssertTrue(model.machineState.showsPrompt)
      XCTAssertTrue(model.commands(for: step).contains("--build-machine \"Studio\""))
      let relaunched = TutorialModel(defaults: defaults)
      relaunched.update(workspaces: [env], archived: [], sheetOpen: false)
      XCTAssertTrue(relaunched.machineState.showsPrompt)
      XCTAssertTrue(relaunched.commands(for: step).contains("--build-machine \"Studio\""))
    }

    @MainActor func testResumeArchivedTourShowsDone() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 1, tourPath: "/tmp/tutorial-tour", startedAt: ISO8601DateFormatter().date(from: "2026-10-07T12:00:00Z")!,
        step: "finish")
      let model = TutorialModel(defaults: defaults)
      model.update(workspaces: [], archived: [try archive()], sheetOpen: false)
      XCTAssertTrue(model.isOpen)
      XCTAssertTrue(model.snapshot?.isComplete == true)
    }

    @MainActor func testOpeningBeforeStatusLoadsPreservesArchivedResumeDetection() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 1, tourPath: "/tmp/tutorial-tour", startedAt: ISO8601DateFormatter().date(from: "2026-10-07T12:00:00Z")!,
        step: "build", done: ["begin", "sidebar"])
      let model = TutorialModel(defaults: defaults)
      model.open()
      XCTAssertNil(model.snapshot)
      model.update(workspaces: [], archived: [try archive()], sheetOpen: false)
      XCTAssertTrue(model.snapshot?.isComplete == true)
    }

    @MainActor func testBeginningWaitsForStatusAndUsesReportedRunStart() throws {
      let model = TutorialModel(defaults: isolatedDefaults())
      model.open(beginning: true)
      XCTAssertNil(model.snapshot)
      model.update(workspaces: [try workspace()], archived: [], sheetOpen: false)
      XCTAssertEqual(model.snapshot?.record.startedAt, ISO8601DateFormatter().date(from: "2026-10-07T12:00:00Z"))
    }

    @MainActor func testOldArchiveCannotCompleteFinishInRestartedRun() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 1, tourPath: "/tmp/tutorial-tour", startedAt: ISO8601DateFormatter().date(from: "2026-10-07T12:02:00Z")!,
        step: "finish", done: TutorialSteps.all.dropLast().map(\.id))
      let model = TutorialModel(defaults: defaults)
      model.open()
      var entry = try archive()
      model.update(workspaces: [], archived: [entry], sheetOpen: false)
      XCTAssertEqual(model.snapshot?.currentStep, "finish")
      entry.removedAt = "2026-10-07T12:03:00Z"
      model.update(workspaces: [], archived: [entry], sheetOpen: false)
      XCTAssertTrue(model.snapshot?.isComplete == true)
    }

    @MainActor func testRestartIgnoresNewerPhaseUntilWorkspaceDisappearsAndReturns() throws {
      let defaults = isolatedDefaults()
      let start = ISO8601DateFormatter().date(from: "2026-10-07T12:00:00Z")!
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 1, tourPath: "/tmp/tutorial-tour", startedAt: start, step: "build",
        done: ["begin"], skipped: ["sidebar"], manual: true)
      let model = TutorialModel(defaults: defaults)
      let env = try workspace()
      model.update(workspaces: [env], archived: [], sheetOpen: false, now: start)
      model.restart(now: start.addingTimeInterval(30))
      model.update(workspaces: [env], archived: [], sheetOpen: false, now: start.addingTimeInterval(31))
      let newerPhase = try workspace(since: "2026-10-07T12:01:00Z")
      model.update(
        workspaces: [newerPhase], archived: [], sheetOpen: false, now: start.addingTimeInterval(61))
      XCTAssertTrue(model.restarting)
      XCTAssertTrue(model.manual)
      XCTAssertEqual(model.snapshot?.record.startedAt, start)
      XCTAssertEqual(model.snapshot?.record.skipped, ["sidebar"])
      XCTAssertEqual(model.snapshot?.currentStep, "build")
      model.update(workspaces: [], archived: [], sheetOpen: false, now: start.addingTimeInterval(62))
      model.update(workspaces: [newerPhase], archived: [], sheetOpen: false, now: start.addingTimeInterval(63))
      XCTAssertFalse(model.restarting)
      XCTAssertFalse(model.manual)
      XCTAssertEqual(model.snapshot?.record.skipped, [])
      XCTAssertEqual(model.snapshot?.record.startedAt, start.addingTimeInterval(63))
      XCTAssertEqual(model.snapshot?.currentStep, "sidebar")
    }

    @MainActor func testWaitingTimeoutStartsWhenPromptIsCopied() {
      let defaults = isolatedDefaults()
      let model = TutorialModel(defaults: defaults)
      model.open()
      let now = Date()
      model.update(workspaces: [], archived: [], sheetOpen: false, now: now.addingTimeInterval(300))
      XCTAssertEqual(model.message, "Waiting for the tutorial workspace...")
      model.copiedPrompt(now: now.addingTimeInterval(300))
      model.copiedPrompt(now: now.addingTimeInterval(400))
      let relaunched = TutorialModel(defaults: defaults)
      relaunched.open()
      relaunched.update(workspaces: [], archived: [], sheetOpen: false, now: now.addingTimeInterval(480))
      XCTAssertEqual(relaunched.message, "No tutorial workspace yet. Ask your agent what failed")
      relaunched.setManual(true)
      XCTAssertEqual(relaunched.message, "Waiting for the tutorial workspace...")
      model.open(beginning: true)
      model.setManual(true)
      model.copiedPrompt(now: now)
      model.update(workspaces: [], archived: [], sheetOpen: false, now: now.addingTimeInterval(300))
      XCTAssertNil(model.snapshot?.record.runPromptCopiedAt)
      XCTAssertEqual(model.message, "Waiting for the tutorial workspace...")
    }

    @MainActor func testOldViewerEventsCannotCompleteANewTourOnAReusedDevice() throws {
      let env = try JSONDecoder().decode(
        Workspace.self,
        from: Data(
          """
          {"path":"/tmp/new-tour","live":true,"warnings":[],"tutorial":{"version":1},"phase":"ready",
           "ios":{"udid":"reused-simulator","state":"Booted","owned":true,"app":{"id":"dev.stim.tutorial","state":"running"}}}
          """.utf8))
      for (count, beginning) in [(62, false), (64, false), (64, true)] {
        let events = TutorialViewerEvents()
        for _ in 0..<(count / 2) {
          events.opened("reused-simulator")
          events.input("reused-simulator")
        }
        let model = TutorialModel(defaults: isolatedDefaults())
        model.update(workspaces: [env], archived: [], sheetOpen: false, viewerEvents: events.events)
        if beginning { model.open(beginning: true) }
        for _ in 0..<3 { model.skip() }
        XCTAssertEqual(model.snapshot?.currentStep, "device")
        events.opened("reused-simulator")
        model.update(workspaces: [env], archived: [], sheetOpen: false, viewerEvents: events.events)
        XCTAssertEqual(model.snapshot?.currentStep, "device")
        events.input("reused-simulator")
        model.update(workspaces: [env], archived: [], sheetOpen: false, viewerEvents: events.events)
        XCTAssertEqual(model.snapshot?.currentStep, "logs")
      }
    }

    @MainActor func testSetupEntryBeginsWhileHelpResumes() {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 1, startedAt: Date(), step: "build", done: ["begin", "sidebar"], manual: true)
      let model = TutorialModel(defaults: defaults)
      model.open()
      XCTAssertNil(model.snapshot)
      model.update(workspaces: [], archived: [], sheetOpen: false)
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
      model.update(workspaces: [try workspace()], archived: [], sheetOpen: false)
      let now = Date()
      model.update(workspaces: [], archived: [], sheetOpen: false, now: now)
      model.update(workspaces: [], archived: [], sheetOpen: false, now: now.addingTimeInterval(30))
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
      model.update(workspaces: [try workspace()], archived: [], sheetOpen: false)
      let now = Date()
      model.update(workspaces: [], archived: [], sheetOpen: false, now: now)
      XCTAssertFalse(model.snapshot?.isComplete == true)
      model.update(workspaces: [], archived: [], sheetOpen: false, now: now.addingTimeInterval(11))
      XCTAssertTrue(model.snapshot?.isComplete == true)
    }
  }
#endif
