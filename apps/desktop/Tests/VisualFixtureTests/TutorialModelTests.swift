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

    private func workspace(
      path: String = "/tmp/tutorial-tour", since: String = "2026-10-07T12:00:00Z", version: Int = 2
    ) throws -> Workspace {
      try JSONDecoder().decode(
        Workspace.self,
        from: Data(
          """
          {"path":"\(path)","live":true,"warnings":[],"tutorial":{"version":\(version)},"worktree":{"path":"\(path)","repository":"/tmp/tutorial"},
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

    @MainActor func testResumeRestoresSkippedSteps() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 2, tourPath: "/tmp/tutorial-tour", startedAt: Date(), step: "build",
        done: ["begin"], skipped: ["device"])
      let model = TutorialModel(defaults: defaults)
      model.update(workspaces: [try workspace()], archived: [], sheetOpen: false)
      XCTAssertTrue(model.isOpen)
      XCTAssertEqual(model.snapshot?.currentStep, "build")
      XCTAssertEqual(model.snapshot?.record.skipped, ["device"])
    }

    @MainActor func testResumeArchivedTourOffersTheDeleteStep() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 2, tourPath: "/tmp/tutorial-tour", startedAt: ISO8601DateFormatter().date(from: "2026-10-07T12:00:00Z")!,
        step: "finish")
      let model = TutorialModel(defaults: defaults)
      model.update(workspaces: [], archived: [try archive()], sheetOpen: false)
      XCTAssertTrue(model.isOpen)
      XCTAssertEqual(model.snapshot?.currentStep, "delete")
      XCTAssertNil(model.notice)
    }

    @MainActor func testOpeningBeforeStatusLoadsPreservesArchivedResumeDetection() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 2, tourPath: "/tmp/tutorial-tour", startedAt: ISO8601DateFormatter().date(from: "2026-10-07T12:00:00Z")!,
        step: "build", done: ["begin"])
      let model = TutorialModel(defaults: defaults)
      model.open()
      XCTAssertNil(model.snapshot)
      model.update(workspaces: [], archived: [try archive()], sheetOpen: false)
      XCTAssertEqual(model.snapshot?.currentStep, "delete")
    }

    @MainActor func testBeginningStartsNowAndIgnoresWorktreesFromBefore() throws {
      let model = TutorialModel(defaults: isolatedDefaults())
      let begun = Date()
      model.open(beginning: true)
      XCTAssertNil(model.snapshot)
      model.update(workspaces: [try workspace()], archived: [], sheetOpen: false, now: begun)
      XCTAssertNil(model.snapshot?.record.tourPath)
      XCTAssertEqual(model.snapshot?.currentStep, "begin")
      XCTAssertGreaterThanOrEqual(try XCTUnwrap(model.snapshot?.record.startedAt), begun.addingTimeInterval(-5))
      let later = ISO8601DateFormatter().string(from: begun.addingTimeInterval(60))
      let fresh = try workspace(path: "/tmp/fresh-tour", since: later)
      model.update(workspaces: [try workspace(), fresh], archived: [], sheetOpen: false, now: begun.addingTimeInterval(61))
      XCTAssertEqual(model.snapshot?.record.tourPath, "/tmp/fresh-tour")
    }

    @MainActor func testOldArchiveCannotCompleteFinishInRestartedRun() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 2, tourPath: "/tmp/tutorial-tour", startedAt: ISO8601DateFormatter().date(from: "2026-10-07T12:02:00Z")!,
        step: "finish", done: TutorialSteps.all.prefix { $0.id != "finish" }.map(\.id))
      let model = TutorialModel(defaults: defaults)
      model.open()
      var entry = try archive()
      model.update(workspaces: [], archived: [entry], sheetOpen: false)
      XCTAssertEqual(model.snapshot?.currentStep, "finish")
      entry.removedAt = "2026-10-07T12:03:00Z"
      model.update(workspaces: [], archived: [entry], sheetOpen: false)
      XCTAssertEqual(model.snapshot?.currentStep, "delete")
    }

    @MainActor func testRestartLooksLikeAFirstStartWhileAnOlderVersionTourIsStillRegistered() throws {
      let defaults = isolatedDefaults()
      let start = ISO8601DateFormatter().date(from: "2026-10-07T12:00:00Z")!
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 2, tourPath: "/tmp/tutorial-tour", startedAt: start, step: "build",
        done: ["begin"], skipped: ["device"])
      let model = TutorialModel(defaults: defaults)
      let old = try workspace(version: 1)
      model.update(workspaces: [old], archived: [], sheetOpen: false, now: start)
      XCTAssertEqual(model.notice?.action, .restart)
      XCTAssertEqual(model.snapshot?.steps.first { $0.id == "build" }?.action, .restart)
      XCTAssertNil(model.ask(for: try XCTUnwrap(TutorialSteps.all.first { $0.id == "build" })))
      model.open(beginning: true, now: start.addingTimeInterval(30))
      XCTAssertNil(model.snapshot?.record.tourPath)
      XCTAssertEqual(model.snapshot?.currentStep, "begin")
      XCTAssertEqual(model.notice, TutorialNotice("Waiting for the tutorial workspace..."))
      XCTAssertEqual(model.snapshot?.steps.filter { $0.state != .pending }.map(\.id), ["begin"])
      model.update(workspaces: [old], archived: [], sheetOpen: false, now: start.addingTimeInterval(31))
      XCTAssertNil(model.workspace)
      XCTAssertEqual(model.notice, TutorialNotice("Waiting for the tutorial workspace..."))
      let fresh = try workspace(path: "/tmp/restarted-tour", since: "2026-10-07T12:02:00Z")
      model.update(workspaces: [old, fresh], archived: [], sheetOpen: false, now: start.addingTimeInterval(121))
      XCTAssertEqual(model.snapshot?.record.tourPath, "/tmp/restarted-tour")
      XCTAssertEqual(model.snapshot?.record.skipped, [])
      XCTAssertEqual(model.snapshot?.record.startedAt, start.addingTimeInterval(30))
      XCTAssertEqual(model.snapshot?.currentStep, "build")
    }

    @MainActor func testWaitingTimeoutStartsWhenPromptIsCopied() {
      let defaults = isolatedDefaults()
      let model = TutorialModel(defaults: defaults)
      model.open()
      let now = Date()
      model.update(workspaces: [], archived: [], sheetOpen: false, now: now.addingTimeInterval(300))
      XCTAssertEqual(model.notice, TutorialNotice("Waiting for the tutorial workspace..."))
      model.copiedPrompt(now: now.addingTimeInterval(300))
      model.copiedPrompt(now: now.addingTimeInterval(400))
      let relaunched = TutorialModel(defaults: defaults)
      relaunched.open()
      relaunched.update(workspaces: [], archived: [], sheetOpen: false, now: now.addingTimeInterval(480))
      XCTAssertEqual(
        relaunched.notice, TutorialNotice("No tutorial workspace yet. Ask your agent what failed", action: .restart))
      model.open(beginning: true)
      model.update(workspaces: [], archived: [], sheetOpen: false, now: now.addingTimeInterval(300))
      XCTAssertNil(model.snapshot?.record.runPromptCopiedAt)
      XCTAssertEqual(model.notice, TutorialNotice("Waiting for the tutorial workspace..."))
    }

    @MainActor func testOldViewerEventsCannotCompleteANewTourOnAReusedDevice() throws {
      let env = try JSONDecoder().decode(
        Workspace.self,
        from: Data(
          """
          {"path":"/tmp/new-tour","live":true,"warnings":[],"tutorial":{"version":2},"worktree":{"path":"/tmp/new-tour","repository":"/tmp/tutorial"},"phase":"ready",
           "ios":{"udid":"reused-simulator","state":"Booted","owned":true,"app":{"id":"dev.stim.tutorial","state":"running"}}}
          """.utf8))
      for count in [62, 64] {
        let events = TutorialViewerEvents()
        for _ in 0..<(count / 2) {
          events.opened("reused-simulator")
          events.input("reused-simulator")
        }
        let model = TutorialModel(defaults: isolatedDefaults())
        model.update(workspaces: [env], archived: [], sheetOpen: false, viewerEvents: events.events)
        for _ in 0..<2 { model.skip() }
        XCTAssertEqual(model.snapshot?.currentStep, "device")
        events.opened("reused-simulator")
        model.update(workspaces: [env], archived: [], sheetOpen: false, viewerEvents: events.events)
        XCTAssertEqual(model.snapshot?.currentStep, "device")
        events.input("reused-simulator")
        model.update(workspaces: [env], archived: [], sheetOpen: false, viewerEvents: events.events)
        XCTAssertEqual(model.snapshot?.currentStep, "agent")
      }
    }

    @MainActor func testSetupEntryBeginsWhileHelpResumes() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 2, startedAt: Date(), step: "build", done: ["begin"])
      let model = TutorialModel(defaults: defaults)
      model.open()
      XCTAssertNil(model.snapshot)
      model.update(workspaces: [], archived: [], sheetOpen: false)
      XCTAssertEqual(model.snapshot?.currentStep, "build")
      model.open(beginning: true)
      XCTAssertEqual(model.snapshot?.currentStep, "begin")
      let begin = try XCTUnwrap(TutorialSteps.all.first { $0.id == "begin" })
      XCTAssertTrue(try XCTUnwrap(model.ask(for: begin)).contains("~/stim-tutorial"))
    }

    @MainActor func testDeletedWorkspaceRequiresRestartWithoutObservedStop() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(
        version: 2, tourPath: "/tmp/tutorial-tour", startedAt: Date(), step: "finish",
        done: TutorialSteps.all.prefix { $0.id != "finish" }.map(\.id))
      let model = TutorialModel(defaults: defaults)
      model.update(workspaces: [try workspace()], archived: [], sheetOpen: false)
      let now = Date()
      model.update(workspaces: [], archived: [], sheetOpen: false, now: now)
      model.update(workspaces: [], archived: [], sheetOpen: false, now: now.addingTimeInterval(30))
      XCTAssertFalse(model.snapshot?.isComplete == true)
      XCTAssertEqual(model.notice, TutorialNotice("Tutorial workspace gone: Restart", action: .restart))
    }

    @MainActor func testFinishWithoutArchiveWaitsForGraceAndObservedStop() throws {
      let defaults = isolatedDefaults()
      var record = TutorialRecord(
        version: 2, tourPath: "/tmp/tutorial-tour", startedAt: Date(), step: "finish",
        done: TutorialSteps.all.prefix { $0.id != "finish" }.map(\.id))
      record.stopped = true
      TutorialRecordStore(defaults).record = record
      let model = TutorialModel(defaults: defaults)
      model.update(workspaces: [try workspace()], archived: [], sheetOpen: false)
      let now = Date()
      model.update(workspaces: [], archived: [], sheetOpen: false, now: now)
      XCTAssertFalse(model.snapshot?.isComplete == true)
      model.update(workspaces: [], archived: [], sheetOpen: false, now: now.addingTimeInterval(11))
      XCTAssertEqual(model.snapshot?.currentStep, "delete")
    }

    @MainActor func testStoredVersionOneProgressStartsOverOnAVersionTwoTourAtANewPath() throws {
      let defaults = isolatedDefaults()
      var old = TutorialRecord(
        version: 1, tourPath: "/tmp/old-tour", startedAt: Date(), step: "refresh", done: ["begin", "build"])
      old.stepSince = Date()
      TutorialRecordStore(defaults).record = old
      let model = TutorialModel(defaults: defaults)
      model.update(workspaces: [try workspace()], archived: [], sheetOpen: false)
      XCTAssertEqual(model.snapshot?.record.version, 2)
      XCTAssertEqual(model.snapshot?.record.tourPath, "/tmp/tutorial-tour")
      XCTAssertEqual(model.snapshot?.currentStep, "build")
      XCTAssertNil(model.notice)
    }

    @MainActor func testRelaunchDuringTheFirstStepReopensThePanel() throws {
      let defaults = isolatedDefaults()
      TutorialRecordStore(defaults).record = TutorialRecord(version: 2, startedAt: Date(), step: "begin")
      let model = TutorialModel(defaults: defaults)
      model.update(workspaces: [], archived: [], sheetOpen: false)
      XCTAssertTrue(model.isOpen)
      XCTAssertEqual(model.snapshot?.currentStep, "begin")
    }
  }
#endif
