#if DEBUG
  import AppKit
  import StimKit
  import SwiftUI
  import XCTest

  @testable import StimDesktop

  final class TutorialScreenshotTests: XCTestCase {
    @MainActor func testTutorialScreenshots() throws {
      guard let directory = ProcessInfo.processInfo.environment["STIM_TUTORIAL_SHOTS"] else {
        throw XCTSkip("Set STIM_TUTORIAL_SHOTS to render tutorial fixtures.")
      }
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      for name in TutorialSteps.all.map(\.id) + ["done", "failure", "manual", "begin-timeout"] {
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

    var body: some View {
      let snapshot = fixture()
      TutorialPanel(
        snapshot: snapshot, fixtureRendering: true,
        message: name == "begin" ? "Waiting for the tutorial workspace..." : nil,
        prompt: name == "failure" ? "Continue the Stim tutorial: run" : nil,
        commands: { step in
          tutorialCommands(
            step.manual, tourPath: "/Users/example/stim-tutorial-tour", repository: "/Users/example/stim-tutorial",
            stateDir: "/Users/example/.stim/workspaces/tutorial/agent-device", machine: "Studio")
        }
      )
      .frame(width: 320, height: 960)
    }

    private func fixture() -> TutorialSnapshot {
      let id = name == "failure" ? "build" : name == "manual" ? "agent" : name == "begin-timeout" ? "begin" : name
      let now = Date(timeIntervalSince1970: 1_791_374_400)
      var engine = TutorialProgress()
      let done = name == "done" ? TutorialSteps.all.map(\.id) : TutorialSteps.all.prefix { $0.id != id }.map(\.id)
      var record = TutorialRecord(version: 1, startedAt: now, step: id, done: done, manual: name == "manual")
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
      var snapshot = engine.update(
        TutorialInput(environment: name == "device" ? TutorialEnvironment(deviceWorkspace) : nil, now: now, record: record))
      if let index = snapshot.steps.firstIndex(where: { $0.id == id }) {
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
