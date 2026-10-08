import StimKit
import SwiftUI

struct AddMachineSteps: View {
  @Bindable var model: AddMachineModel
  private var name: String { model.wizard.mac?.hostName ?? "the build Mac" }

  var body: some View {
    switch model.page {
    case .tools: tools
    case .test: test
    case .summary: summary
    case .setup: EmptyView()
    }
  }

  private var tools: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("Tools on \(name)").font(.stim(.title))
      Text("Compared with this Mac. Only a red row stops Next; an amber row says what it costs.")
        .foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
      ForEach(model.tools) { tool in
        VStack(alignment: .leading, spacing: Space.xs) {
          Label(tool.title, systemImage: icon(tool)).font(.stim(.body, weight: .semibold))
            .foregroundStyle(color(tool))
          if let detail = tool.detail {
            Text(detail).font(.stim(.footnote)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
          }
          if let consequence = tool.consequence {
            Text(consequence).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          if let fix = tool.state.fix {
            Text(tool.onThisMac ? "Problem on this Mac:" : "Fix for \(name):")
              .font(.stim(.footnote, weight: .semibold))
            ForEach(Array(fix.split(separator: "\n").map(String.init).enumerated()), id: \.offset) { _, line in
              if wizardFixIsCommand(line) {
                CopyableCommand(command: line)
              } else {
                Text(line).font(.stim(.footnote)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
              }
            }
          }
          if tool.id == "stim-build" {
            MachineUpdateLine(phase: model.machineEntry.flatMap { model.machines?.updates[$0] }, needed: tool.state.fix != nil) {
              Task {
                if let entry = model.machineEntry { await model.machines?.update(entry, checkout: model.doctorPath) }
                await model.refreshTools()
              }
            }
          }
        }
      }
    }
  }

  @ViewBuilder private var test: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("Test Build").font(.stim(.title))
      Text("Expo blank (SDK 58), in Stim Desktop's own folder.").foregroundStyle(Palette.secondary)
      if let sample = model.sample {
        Text(abbreviatingHome(sample.folder)).font(.stim(.caption, mono: true)).textSelection(.enabled)
        testStatus(sample.test.state)
        if model.isFixture, sample.running {
          Text("Elapsed 0:45").monospacedDigit()
        } else if let start = sample.startedAt, sample.running {
          TimelineView(.periodic(from: start, by: 1)) { context in
            Text("Elapsed \(sampleDuration(context.date.timeIntervalSince(start) * 1000))").monospacedDigit()
          }
        }
        if let timings = sample.test.timings {
          VStack(alignment: .leading, spacing: Space.sm) {
            Text("On \(name)").font(.stim(.headline))
            timeRow("Upload / sync", timings.offerMs + timings.syncMs)
            timeRow("Build", timings.workerMs)
            timeRow("Download / fetch", timings.fetchMs)
            timeRow("Total", timings.totalMs)
            if let local = sample.test.localMs {
              Text("This Mac can still build it: \(sampleDuration(local))").foregroundStyle(Palette.success)
              Text(speedComparison(machine: name, offloadMs: timings.totalMs, localMs: local))
            }
          }
        }
        if !sample.lines.isEmpty {
          TerminalCard(lines: sample.lines, mode: .live, width: nil, animates: !model.isFixture, height: 208, maxVisibleLines: 10)
        }
        if let error = sample.cleanupError { Text("Could not stop the sample: \(error)").foregroundStyle(Palette.error) }
        HStack {
          if !sample.sampleReady {
            Button("Retry") { sample.prepare() }.disabled(sample.preparing)
          } else {
            Button(sample.test.state == .ready ? "Run test" : "Run again") {
              if let entry = model.machineEntry {
                sample.run(entry: entry)
              }
            }.disabled(sample.running || !model.wizard.capabilities.contains(.build))
          }
          Button("Skip Test") { Task { await sample.skip() } }
        }
      }
      if !model.wizard.capabilities.contains(.build) {
        Text("Hosted simulators are approved. A build test needs Builds approval; skip this test to finish.")
      }
    }
  }

  @ViewBuilder private func testStatus(_ state: BuildTest.State) -> some View {
    switch state {
    case .preparingSample: Text("Preparing the sample app").foregroundStyle(Palette.secondary)
    case .ready: Text("The sample app is ready.")
    case .offloading(let phase): Text("Building on \(name): \(phase)").foregroundStyle(Palette.secondary)
    case .offloaded: Text("The offloaded sample launched.").foregroundStyle(Palette.success)
    case .localBuilding: Text("Building on this Mac to prove the fallback path.")
    case .done: Label("Both test builds passed", systemImage: "checkmark.circle.fill").foregroundStyle(Palette.success)
    case .failed(let code, let message, let remedy):
      Text(code).font(.stim(.body, mono: true)).foregroundStyle(Palette.error)
      Text(message).foregroundStyle(Palette.error).textSelection(.enabled)
      if let remedy { Text(remedy).textSelection(.enabled) }
    case .skipped: Text("Test skipped. You can run it again from this sample folder.")
    }
  }

  private var summary: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("\(name) is set up").font(.stim(.title))
      VStack(alignment: .leading, spacing: Space.sm) {
        ForEach(SetupCapability.allCases.filter { model.wizard.capabilities.contains($0) }, id: \.self) { capability in
          Label(capability == .build ? "Builds approved" : "Hosted simulators approved", systemImage: "checkmark.circle.fill")
            .foregroundStyle(Palette.success)
        }
        if ![.notRun, .skipped].contains(model.testOutcome), let text = model.testOutcome.summaryText {
          Text(text).foregroundStyle(Palette.secondary)
        }
      }
      if model.wizard.capabilities.contains(.build), let machine = model.machineEntry {
        tryIt(machine)
        choice("Builds", detail: "Auto: when this Mac is busy. Always: prefer \(name). Never: build here.") {
          ForEach(WizardMode.allCases, id: \.self) { choice in
            radio(choice.title, selected: model.mode == choice) { model.mode = choice }
          }
        }
      }
      if model.choosesSimulators, let machine = model.machineEntry {
        choice(
          "Simulators", detail: "Auto: on \(name) when this Mac is full."
        ) {
          ForEach(SimulatorPlacement.allCases, id: \.self) { choice in
            radio(choice.title(machine: name), selected: model.simulators == choice) { model.simulators = choice }
              .help(
                choice.value(machine: machine).map { "ios.remote and android.remote = \($0)" }
                  ?? "Unsets ios.remote and android.remote")
          }
        }
        if model.simulators == nil {
          Text("Done keeps the current ios.remote and android.remote unless you choose.").font(.stim(.footnote))
            .foregroundStyle(Palette.secondary)
        }
      }
      Text("You can remove \(name) later in Settings > Remote Macs > Remove.")
        .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
    }
  }

  private func choice<Options: View>(_ title: String, detail: String, @ViewBuilder options: () -> Options) -> some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Text(title).font(.stim(.headline))
      HStack(spacing: Space.lg) { options() }
      Text(detail).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
    }
  }

  private func radio(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Label(title, systemImage: selected ? "largecircle.fill.circle" : "circle")
        .foregroundStyle(selected ? Palette.accent : Palette.secondary)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private func tryIt(_ machine: String) -> some View {
    let prompt =
      "Build and run this project on iOS with Stim, offloading the build to \(machine), then tell me where it built and how long it took."
    return VStack(alignment: .leading, spacing: Space.md) {
      HStack {
        Label("Try It", systemImage: "sparkles").font(.stim(.headline))
        Spacer()
        CopyButton(prompt, title: "Copy Prompt", help: "Copy the agent prompt")
      }
      Text(prompt).font(.stim(.callout)).foregroundStyle(Palette.secondary).textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
      Text("Or run it yourself in a project:").font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      CopyableCommand(command: "stim ios --remote-build \(machine)")
      if model.sample != nil {
        Button("Run a Test Build with a Sample App") { model.openTest() }
          .buttonStyle(.stim(.plain))
      }
    }
    .padding(Space.lg)
    .background(RoundedRectangle(cornerRadius: Radius.card).fill(Palette.surface))
    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border))
  }

  private func timeRow(_ title: String, _ ms: Double) -> some View {
    HStack {
      Label(title, systemImage: "checkmark")
      Spacer()
      Text(sampleDuration(ms)).monospacedDigit()
    }
  }
  private func icon(_ tool: WizardTool) -> String {
    switch tool.state {
    case .ok: return "checkmark.circle.fill"
    case .missing, .mismatch: return tool.blocks ? "xmark.circle.fill" : "exclamationmark.triangle.fill"
    case .checking: return "clock"
    case .busy, .notNeeded: return "minus.circle"
    }
  }
  private func color(_ tool: WizardTool) -> Color {
    switch tool.state {
    case .ok: return Palette.success
    case .missing, .mismatch: return tool.blocks ? Palette.error : Palette.warning
    default: return Palette.secondary
    }
  }
}
