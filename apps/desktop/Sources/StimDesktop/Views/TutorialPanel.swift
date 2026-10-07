import AppKit
import StimKit
import SwiftUI

struct TutorialPanel: View {
  var snapshot: TutorialSnapshot
  #if DEBUG
    var fixtureRendering = false
  #endif
  var restarting = false
  var message: String? = nil
  var prompt: String? = nil
  var issues: [StatusIssue] = []
  var commands: (TutorialStep) -> String
  var copied: () -> Void = {}
  var skip: () -> Void = {}
  var markDone: () -> Void = {}
  var restart: () -> Void = {}
  var setManual: (Bool) -> Void = { _ in }
  var close: () -> Void = {}
  var openArchived: () -> Void = {}
  var updateCLI: () -> Void = {}
  @State private var expanded: String?
  @ObservedObject private var updater = AppUpdater.shared

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        SectionLabel(title: "Stim tutorial")
        Spacer()
        Text("\(position) of \(TutorialSteps.all.count)")
          .font(.stim(.caption)).foregroundStyle(Palette.secondary).monospacedDigit()
      }
      .padding(Space.xl)
      Divider()
      panelContent
      Divider()
      footer.padding(Space.lg)
    }
    .font(.stim(.callout))
    .foregroundStyle(Palette.text)
    .background(Palette.sidebar)
    .tint(Palette.brand)
    .accessibilityLabel("Stim tutorial")
  }

  private var rendersStatic: Bool {
    #if DEBUG
      fixtureRendering
    #else
      false
    #endif
  }

  @ViewBuilder private var panelContent: some View {
    if rendersStatic {
      stepList.frame(maxHeight: .infinity, alignment: .top)
    } else {
      ScrollViewReader { reader in
        ScrollView { stepList }
          .onChange(of: snapshot.currentStep, initial: true) { _, id in
            if let id { reader.scrollTo(id, anchor: .center) }
          }
      }
    }
  }

  private var stepList: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      if restarting {
        TutorialPromptBox(prompt: TutorialSteps.restartPrompt, onCopy: copied)
        Text("Waiting for a restarted tutorial workspace...").foregroundStyle(Palette.secondary)
      }
      if snapshot.isComplete {
        Label("Tutorial complete", systemImage: "checkmark.circle.fill")
          .font(.stim(.headline)).foregroundStyle(Palette.success)
        Text(
          snapshot.steps.first(where: { $0.id == "finish" })?.detail == "Archived is off"
            ? "Archived is off. The tutorial workspace has been removed."
            : "Your workspace, builds, logs and recordings stay in Archived when archiving is enabled."
        )
        .foregroundStyle(Palette.secondary)
        Button("Open Archived", action: openArchived)
          .buttonStyle(.stim(.primary)).accessibilityLabel("Open Archived workspaces")
      }
      ForEach(TutorialSteps.all, id: \.id) { step in
        if let state = snapshot.steps.first(where: { $0.id == step.id }) {
          stepRow(step, state: state).id(step.id)
        }
      }
    }
    .padding(Space.xl)
  }

  private var position: Int {
    snapshot.currentStep.flatMap { id in TutorialSteps.all.firstIndex { $0.id == id }.map { $0 + 1 } }
      ?? TutorialSteps.all.count
  }

  private func stepRow(_ step: TutorialStep, state: TutorialStepProgress) -> some View {
    let current = snapshot.currentStep == step.id
    let open = current || expanded == step.id
    return VStack(alignment: .leading, spacing: Space.md) {
      Button {
        expanded = expanded == step.id ? nil : step.id
      } label: {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
          Image(systemName: icon(state.state)).foregroundStyle(color(state.state)).frame(width: 16)
          Text(step.title).font(.stim(.callout, weight: current ? .semibold : .regular))
          Spacer(minLength: 0)
          if step.optional { Text("Optional").font(.stim(.caption)).foregroundStyle(Palette.tertiary) }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(step.title), \(current ? message ?? stateLabel(state.state) : stateLabel(state.state))")
      .accessibilityValue(open ? "Expanded" : "Collapsed")
      if open {
        VStack(alignment: .leading, spacing: Space.md) {
          Text(explanation(step.id)).foregroundStyle(Palette.secondary)
          if snapshot.record.manual, !step.manual.isEmpty {
            if rendersStatic {
              CommandBlock(commandText: commands(step), onCopy: copied)
                .fixedSize(horizontal: false, vertical: true)
                .frame(height: 280, alignment: .top).clipped()
            } else {
              ScrollView { CommandBlock(commandText: commands(step), onCopy: copied) }
                .frame(maxHeight: 280)
            }
            if step.id == "begin" {
              Text("Then expand First iOS build below for the worktree and build commands.")
                .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
            }
          } else if !step.optional, let text = current ? prompt ?? step.prompt : step.prompt {
            TutorialPromptBox(prompt: text, onCopy: copied)
          }
          let detail = current ? message ?? state.detail : state.detail
          if !detail.isEmpty, current || ["build", "rebuild"].contains(step.id) {
            Text(detail).foregroundStyle(color(state.state)).textSelection(.enabled)
          }
          if detail.contains("Update Stim Desktop") {
            Button("Check for Updates", action: updater.checkForUpdates)
              .buttonStyle(.stim()).disabled(!updater.canCheckForUpdates)
              .accessibilityLabel("Check for Stim Desktop updates")
          } else if detail.contains("Stim CLI") {
            Button("Update Stim CLI", action: updateCLI).buttonStyle(.stim())
              .accessibilityLabel("Open the setup guide to update Stim CLI")
          }
          if detail.contains("Restart") || detail.hasPrefix("No tutorial workspace") {
            Button("Restart tutorial", action: restart).buttonStyle(.stim())
              .accessibilityLabel("Restart the Stim tutorial")
          }
          ForEach(state.ticks, id: \.id) { tick in
            Label(
              tickTitle(tick.id) + (tick.optional ? " (optional)" : ""),
              systemImage: tick.done ? "checkmark.circle.fill" : "circle"
            )
            .font(.stim(.footnote)).foregroundStyle(tick.done ? Palette.success : Palette.secondary)
            .accessibilityLabel("\(tickTitle(tick.id)), \(tick.done ? "done" : "waiting")")
          }
          if current {
            ForEach(issues, id: \.self) { issue in
              Text("\(issue.code): \(issue.message) \(issue.remedy)").foregroundStyle(Palette.warning)
                .textSelection(.enabled)
            }
            if step.optional {
              Button("Skip", action: skip).buttonStyle(.stim(.primary))
                .accessibilityLabel("Skip \(step.title)")
            }
            if state.canMarkDone {
              Button("Mark done", action: markDone).buttonStyle(.stim())
                .accessibilityLabel("Mark \(step.title) done")
            }
            if step.id == "begin", !snapshot.record.manual {
              Button("Show commands", action: { setManual(true) }).buttonStyle(.stim(.plain))
                .accessibilityLabel("Show tutorial commands instead of agent prompts")
            }
          }
        }
        .padding(.leading, Space.xl)
      } else if state.state == .done, ["build", "rebuild"].contains(step.id), !state.detail.isEmpty {
        Text(state.detail).font(.stim(.caption)).foregroundStyle(Palette.tertiary).padding(.leading, Space.xl)
      }
    }
  }

  private var footer: some View {
    HStack {
      if !snapshot.isComplete {
        Button("Skip step", action: skip).buttonStyle(.stim(.plain)).accessibilityLabel("Skip current tutorial step")
      }
      Spacer()
      if rendersStatic {
        Image(systemName: "ellipsis").accessibilityLabel("Tutorial options")
      } else {
        Menu {
          Button("Restart tutorial", action: restart)
          Button(snapshot.record.manual ? "Show prompts instead of commands" : "Show commands instead of prompts") {
            setManual(!snapshot.record.manual)
          }
          Button("Close tutorial", action: close)
        } label: {
          Image(systemName: "ellipsis")
        }
        .menuStyle(.borderlessButton).fixedSize().accessibilityLabel("Tutorial options")
      }
    }
  }

  private func icon(_ state: TutorialStepState) -> String {
    switch state {
    case .done: return "checkmark.circle.fill"
    case .skipped: return "minus.circle"
    case .current: return "arrow.right.circle.fill"
    case .pending: return "circle"
    case .failed: return "exclamationmark.circle.fill"
    }
  }

  private func color(_ state: TutorialStepState) -> Color {
    switch state {
    case .done: return Palette.success
    case .current: return Palette.accent
    case .failed: return Palette.error
    case .pending, .skipped: return Palette.tertiary
    }
  }

  private func stateLabel(_ state: TutorialStepState) -> String {
    switch state {
    case .done: return "done"
    case .skipped: return "skipped"
    case .current: return "current"
    case .pending: return "pending"
    case .failed(let message): return "failed: \(message)"
    }
  }

  private func explanation(_ id: String) -> String {
    switch id {
    case "begin": return "Tell your agent to create a small iOS app in an isolated tutorial worktree."
    case "sidebar": return "The tutorial workspace appears beside your other projects. Select it to follow along."
    case "build":
      return "Watch the first iOS build: prebuild, pods, compile and launch. Open the build details for phase timings."
    case "rebuild": return "Run iOS again. The cache badge shows a hit, or explains why Stim rebuilt."
    case "device": return "Open the simulator's live view, choose Control, then tap Log an error."
    case "logs": return "Open Logs to find the tagged error. Try Crash me and Slow request too."
    case "agent":
      return
        "Your agent can drive the simulator. Paste this, then watch Agent actions. Replay shows the recorded screen beside the actions."
    case "refresh":
      return "Ask your agent to change the title to purple. Watch Fast Refresh update the app without a native build."
    case "phone":
      return "Optional. Pair a phone from Settings > Phones, then open Stim on it to see this workspace. You can skip this step."
    case "machine":
      return "Optional. An approved Mac can build the same app. Choose one in Settings > Build Machines, or skip this step."
    case "finish":
      return
        "Your agent reverts the tutorial edit, stops the workspace and removes only its worktree. Open Archived to revisit its history."
    default: return ""
    }
  }

  private func tickTitle(_ id: String) -> String {
    switch id {
    case "opened": return "Live view opened"
    case "input": return "Device controlled"
    case "error": return "Log an error"
    case "crash": return "Crash me"
    case "slow": return "Slow request"
    case "action": return "Agent action received"
    case "agent-replay": return "agent-device replay"
    case "screen-recording": return "Screen recording replay"
    case "stopped": return "Workspace stopped"
    case "archived": return "Worktree removed and archived"
    case "approved": return "Build machine approved"
    case "offloaded": return "Build ran on another Mac"
    default: return PhaseStep.name(id)
    }
  }
}

private struct TutorialPromptBox: View {
  var prompt: String
  var onCopy: () -> Void
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Text("Tell your agent:").font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      Card {
        VStack(alignment: .leading, spacing: Space.md) {
          Text(prompt).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
          HStack {
            Spacer()
            Button {
              NSPasteboard.general.clearContents()
              NSPasteboard.general.setString(prompt, forType: .string)
              copied = true
              onCopy()
            } label: {
              Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
            }
            .buttonStyle(.stim(.secondary)).accessibilityLabel("Copy prompt: \(prompt)")
            .task(id: copied) {
              guard copied else { return }
              try? await Task.sleep(for: .seconds(2))
              copied = false
            }
          }
        }
        .padding(Space.lg)
      }
    }
  }
}
