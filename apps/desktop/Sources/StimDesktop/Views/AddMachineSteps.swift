import AppKit
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
      Text("Compared with this Mac. Run fixes in Terminal on \(name).").foregroundStyle(Palette.secondary)
      ForEach(model.tools) { tool in
        VStack(alignment: .leading, spacing: Space.xs) {
          Label(tool.title, systemImage: icon(tool.state)).font(.stim(.body, weight: .semibold))
            .foregroundStyle(color(tool.state))
          if let detail = tool.detail { Text(detail).font(.stim(.footnote)).textSelection(.enabled) }
          if tool.id == "stim-build" {
            MachineUpdateLine(phase: model.machineEntry.flatMap { model.machines?.updates[$0] }, needed: tool.state.fix != nil) {
              Task {
                if let entry = model.machineEntry { await model.machines?.update(entry, checkout: model.doctorPath) }
                await model.refreshTools()
              }
            }
          } else if let fix = tool.state.fix {
            copyCommand(fix)
          }
        }
      }
      if !model.checksAndroid {
        Button("Check Android") { Task { await model.checkAndroid() } }.disabled(!model.wizard.capabilities.contains(.build))
      }
    }
  }

  @ViewBuilder private var test: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("Test build").font(.stim(.title))
      Text("Expo blank (SDK 57), in Stim Desktop's own folder.").foregroundStyle(Palette.secondary)
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
          TerminalCard(lines: sample.lines, mode: .live, width: 650, animates: !model.isFixture, height: 208, maxVisibleLines: 10)
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
          Button("Skip test") { Task { await sample.skip() } }
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
      Text("\(name) is ready").font(.stim(.title))
      ForEach(SetupCapability.allCases.filter { model.wizard.capabilities.contains($0) }, id: \.self) { capability in
        let status = capability == .build ? model.wizard.build : model.wizard.host
        Label(
          "\(capability == .build ? "Builds" : "Hosted simulators"): approved request \(status?.deviceId ?? "")",
          systemImage: "checkmark.circle.fill"
        )
        .foregroundStyle(Palette.success)
      }
      Text("When to offload").font(.stim(.headline))
      HStack(spacing: Space.lg) {
        ForEach(WizardMode.allCases, id: \.self) { choice in
          Button {
            model.mode = choice
          } label: {
            Label(choice.title, systemImage: model.mode == choice ? "largecircle.fill.circle" : "circle")
              .foregroundStyle(model.mode == choice ? Palette.accent : Palette.secondary)
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(model.mode == choice ? .isSelected : [])
        }
      }
      Text("Auto: when this Mac is busy. Always: prefer the build Mac. Never: build here.").font(.stim(.footnote))
        .foregroundStyle(Palette.secondary)
      if model.wizard.modeChanged, model.sample?.test.passed != true {
        Text("Never stays selected until a test passes. Choose Auto or Always here to enable offloading yourself.").font(
          .stim(.footnote)
        ).foregroundStyle(Palette.warning)
      }
      ForEach(model.summary.filter { !$0.hasPrefix("offload.mode") }, id: \.self) {
        Text($0).font(.stim(.caption, mono: true)).textSelection(.enabled)
      }
      Text("offload.mode = \(model.mode.rawValue)").font(.stim(.caption, mono: true))
      Text("Undo").font(.stim(.headline))
      Text("On this Mac: Settings > Build machines > Remove")
      Text("On \(name):").font(.stim(.footnote, weight: .semibold))
      ForEach(model.wizard.revokeIds.sorted(), id: \.self) { copyCommand("stim-server devices revoke \($0)") }
      copyCommand("stim-server service uninstall")
      Text("Service uninstall is optional. Stim Host permissions stay in System Settings until you remove them.")
        .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
    }
  }

  private func copyCommand(_ command: String) -> some View {
    HStack(alignment: .top, spacing: Space.sm) {
      CommandText(command: command).fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button("Copy") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
      }
      .accessibilityLabel("Copy " + command)
    }
  }

  private func timeRow(_ title: String, _ ms: Double) -> some View {
    HStack {
      Label(title, systemImage: "checkmark")
      Spacer()
      Text(sampleDuration(ms)).monospacedDigit()
    }
  }
  private func icon(_ state: WizardTool.State) -> String {
    switch state {
    case .ok: return "checkmark.circle.fill"
    case .missing, .mismatch: return "xmark.circle.fill"
    case .checking: return "clock"
    case .busy, .notNeeded: return "minus.circle"
    }
  }
  private func color(_ state: WizardTool.State) -> Color {
    switch state {
    case .ok: return Palette.success
    case .missing, .mismatch: return Palette.warning
    default: return Palette.secondary
    }
  }
}
