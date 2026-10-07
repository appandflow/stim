#if DEBUG
  import AppKit
  import PDFKit
  import StimKit
  import SwiftUI
  import XCTest

  @testable import StimDesktop

  final class TutorialScreenshotTests: XCTestCase {
    @MainActor func testRestartShowsPromptAndWaitingMessageOnce() throws {
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      var engine = TutorialProgress()
      let now = Date()
      let snapshot = engine.update(
        TutorialInput(environment: nil, now: now, record: TutorialRecord(version: 1, startedAt: now)))
      let panel = TutorialPanel(
        snapshot: snapshot, fixtureRendering: true, restarting: true,
        message: "Waiting for a restarted tutorial workspace...", prompt: TutorialSteps.restartPrompt,
        commands: { _ in "" })
      let data = NSMutableData()
      let consumer = try XCTUnwrap(CGDataConsumer(data: data))
      var bounds = CGRect(x: 0, y: 0, width: 320, height: 960)
      let context = try XCTUnwrap(CGContext(consumer: consumer, mediaBox: &bounds, nil))
      ImageRenderer(content: panel.frame(width: bounds.width, height: bounds.height)).render { _, draw in
        context.beginPDFPage(nil)
        draw(context)
        context.endPDFPage()
      }
      context.closePDF()
      let rendered = try XCTUnwrap(PDFDocument(data: data as Data)?.string)
      XCTAssertEqual(rendered.components(separatedBy: TutorialSteps.restartPrompt).count - 1, 1)
      XCTAssertEqual(rendered.components(separatedBy: "Waiting for a restarted tutorial").count - 1, 1)
    }

    @MainActor func testTutorialScreenshots() throws {
      guard let directory = ProcessInfo.processInfo.environment["STIM_TUTORIAL_SHOTS"] else {
        throw XCTSkip("Set STIM_TUTORIAL_SHOTS to render tutorial fixtures.")
      }
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      let variants = [
        "done", "failure", "manual", "begin-timeout", "restarting", "phone-not-paired", "phone-server-off",
        "phone-already-paired",
        "machine-none", "machine-approved", "machine-offloaded",
      ]
      for name in TutorialSteps.all.map(\.id) + variants {
        for dark in [false, true] {
          let renderer = ImageRenderer(
            content: TutorialFixtureView(name: name)
              .environment(\.colorScheme, dark ? .dark : .light)
              .environment(\.locale, Locale(identifier: "en_US")))
          renderer.scale = 2
          let image = try XCTUnwrap(renderer.cgImage, "\(name) did not render")
          let png = try XCTUnwrap(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
          try png.write(
            to: URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png"))
        }
      }
    }
  }

  private struct TutorialFixtureView: View {
    var name: String

    private var phoneCount: Int? {
      if name == "phone-server-off" { return nil }
      return name == "phone-already-paired" ? 1 : 0
    }

    private var machineState: TutorialMachineState {
      TutorialMachineState(
        configured: name == "machine-approved" || name == "machine-offloaded",
        approved: name == "machine-approved" || name == "machine-offloaded")
    }

    var body: some View {
      let snapshot = fixture()
      TutorialPanel(
        snapshot: snapshot, fixtureRendering: true, restarting: name == "restarting",
        message: name == "begin" ? "Waiting for the tutorial workspace..." : nil,
        prompt: name == "failure" ? "Continue the Stim tutorial: run" : nil,
        phoneState: TutorialPhoneState(pairedPhoneCount: phoneCount), machineState: machineState,
        commands: { step in
          tutorialCommands(
            step.manual, tourPath: "/Users/example/stim-tutorial-tour", repository: "/Users/example/stim-tutorial",
            stateDir: "/Users/example/.stim/workspaces/tutorial/agent-device", machine: "Studio")
        }
      )
      .frame(width: 320, height: machineState.showsPrompt ? 1120 : 960)
    }

    private func fixture() -> TutorialSnapshot {
      let id =
        name.hasPrefix("phone-")
        ? "phone"
        : name.hasPrefix("machine-")
          ? "machine"
          : ["failure", "restarting"].contains(name)
            ? "build" : name == "manual" ? "agent" : name == "begin-timeout" ? "begin" : name
      let now = Date(timeIntervalSince1970: 1_791_374_400)
      var engine = TutorialProgress()
      let done = name == "done" ? TutorialSteps.all.map(\.id) : TutorialSteps.all.prefix { $0.id != id }.map(\.id)
      var record = TutorialRecord(version: 1, startedAt: now, step: id, done: done, manual: name == "manual")
      if ["machine", "finish"].contains(id) {
        record.done.removeAll { $0 == "phone" }
        record.skipped = ["phone"]
      }
      if name == "begin-timeout" {
        record.startedAt = now.addingTimeInterval(-300)
        record.runPromptCopiedAt = now.addingTimeInterval(-180)
      }
      let deviceWorkspace = try! JSONDecoder().decode(
        Workspace.self,
        from: Data(
          """
          {"path":"/Users/example/stim-tutorial-tour","live":true,"warnings":[],"tutorial":{"version":1},
           "ios":{"udid":"tutorial-simulator","state":"Booted","owned":true,"app":{"id":"dev.stim.tutorial","state":"running"}}}
          """.utf8))
      var workspace = deviceWorkspace
      if name == "machine-offloaded" {
        workspace.lastBuilds = try! JSONDecoder().decode(
          LastBuilds.self,
          from: Data(
            """
            {"ios":{"platform":"ios","status":"ok","cacheHit":false,
            "startedAt":"\(ISO8601DateFormatter().string(from: now))","offloadedTo":"Studio"}}
            """.utf8))
      }
      var snapshot = engine.update(
        TutorialInput(
          environment: id == "device" || id == "machine" ? TutorialEnvironment(workspace) : nil,
          pairedPhoneCount: phoneCount, machineApproved: machineState.showsPrompt, now: now, record: record))
      if let index = snapshot.steps.firstIndex(where: { $0.id == id }), !["phone", "machine"].contains(id) {
        snapshot.steps[index].state = name == "failure" ? .failed("compile-failed: App.js: Unexpected token") : .current
        snapshot.steps[index].detail =
          name == "failure" ? "compile-failed: App.js: Unexpected token" : snapshot.steps[index].detail
      }
      if let index = snapshot.steps.firstIndex(where: { $0.id == "build" }), id != "build", id != "begin", id != "sidebar" {
        snapshot.steps[index].detail = "Built in 4m 24s: no earlier build"
      }
      if let index = snapshot.steps.firstIndex(where: { $0.id == "rebuild" }), done.contains("rebuild") {
        snapshot.steps[index].detail = "Local cache hit in 7.7s"
      }
      if name == "finish" {
        snapshot.steps[snapshot.steps.count - 1].ticks[0].done = true
      }
      if name == "done", let index = snapshot.steps.firstIndex(where: { $0.id == "phone" }) {
        snapshot.steps[index].state = .skipped
      }
      return snapshot
    }
  }
#endif
