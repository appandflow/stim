#if DEBUG
  import AppKit
  import PDFKit
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
      let variants = [
        "done", "failure", "agent-commands", "finish-commands", "build-no-agent-device", "begin-timeout",
        "phone-not-paired", "phone-server-off",
        "phone-already-paired", "phone-paired-during-step",
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
      return ["phone-already-paired", "phone-paired-during-step"].contains(name) ? 1 : 0
    }

    private var storage: UserDefaults {
      let defaults = UserDefaults(suiteName: "TutorialFixture")!
      defaults.set(name.hasSuffix("-commands"), forKey: "tutorial.commandsExpanded")
      return defaults
    }

    var body: some View {
      let snapshot = fixture()
      TutorialPanel(
        snapshot: snapshot, fixtureRendering: true,
        message: name == "begin" ? TutorialNotice("Waiting for the tutorial workspace...") : nil,
        phoneState: TutorialPhoneState(pairedPhoneCount: phoneCount),
        canRunIOS: true, agentDeviceMissing: name == "build-no-agent-device",
        asks: { step in
          step.ask.map {
            tutorialAsk(
              $0, tourPath: "/Users/example/stim-tutorial-tour", repository: "/Users/example/stim-tutorial",
              second: snapshot.record.secondPath)
          }
        },
        commands: { step in
          tutorialCommands(
            step.commands, tourPath: "/Users/example/stim-tutorial-tour", repository: "/Users/example/stim-tutorial",
            stateDir: "/Users/example/.stim/workspaces/tutorial/agent-device",
            udid: "tutorial-simulator", second: "/Users/example/stim-tutorial-second")
        }
      )
      .defaultAppStorage(storage)
      .frame(
        width: 320,
        height: name.hasSuffix("-commands") || name == "build-no-agent-device" ? 1500 : 960)
    }

    private func fixture() -> TutorialSnapshot {
      let id =
        name.hasPrefix("phone-")
        ? "phone"
        : name == "failure"
          ? "build"
          : name == "agent-commands"
            ? "agent"
            : name == "finish-commands"
              ? "finish" : name == "build-no-agent-device" ? "build" : name == "begin-timeout" ? "begin" : name
      let now = Date(timeIntervalSince1970: 1_791_374_400)
      var engine = TutorialProgress()
      let done = name == "done" ? TutorialSteps.all.map(\.id) : TutorialSteps.all.prefix { $0.id != id }.map(\.id)
      var record = TutorialRecord(
        version: 2, startedAt: now, step: id, done: done)
      if name == "phone-paired-during-step" { record.phonePairedAtStart = false }
      if name.hasPrefix("finish") { record.secondPath = "/Users/example/stim-tutorial-second" }
      let skippedOptional = TutorialSteps.all.prefix { $0.id != id }.filter(\.optional).map(\.id)
      if name != "done" {
        record.done.removeAll { skippedOptional.contains($0) }
        record.skipped = skippedOptional
      }
      if name == "begin-timeout" {
        record.startedAt = now.addingTimeInterval(-300)
        record.runPromptCopiedAt = now.addingTimeInterval(-180)
      }
      let deviceWorkspace = try! JSONDecoder().decode(
        Workspace.self,
        from: Data(
          """
          {"path":"/Users/example/stim-tutorial-tour","live":true,"warnings":[],"tutorial":{"version":2},
           "agentDevice":{"stateDir":"/Users/example/.stim/agent-device","installed":\(name != "build-no-agent-device")},
           "ios":{"udid":"tutorial-simulator","state":"Booted","owned":true,"app":{"id":"dev.stim.tutorial","state":"running"}}}
          """.utf8))
      let workspace = deviceWorkspace
      var snapshot = engine.update(
        TutorialInput(
          environment: ["device", "agent"].contains(id) ? TutorialEnvironment(workspace) : nil,
          pairedPhoneCount: phoneCount, now: now, record: record))
      if let index = snapshot.steps.firstIndex(where: { $0.id == id }), id != "phone" {
        snapshot.steps[index].state = name == "failure" ? .failed("compile-failed: App.js: Unexpected token") : .current
        snapshot.steps[index].detail =
          name == "failure" ? "compile-failed: App.js: Unexpected token" : snapshot.steps[index].detail
      }
      if let index = snapshot.steps.firstIndex(where: { $0.id == "build" }), id != "build", id != "begin" {
        snapshot.steps[index].detail = "Built in 4m 24s: no earlier build"
      }
      if let index = snapshot.steps.firstIndex(where: { $0.id == "parallel" }), done.contains("parallel") {
        snapshot.steps[index].detail = "Local cache hit in 7.7s"
      }
      if name == "finish", let index = snapshot.steps.firstIndex(where: { $0.id == "finish" }) {
        snapshot.steps[index].ticks[0].done = true
      }
      if name == "done", let index = snapshot.steps.firstIndex(where: { $0.id == "phone" }) {
        snapshot.steps[index].state = .skipped
      }
      return snapshot
    }
  }
#endif
