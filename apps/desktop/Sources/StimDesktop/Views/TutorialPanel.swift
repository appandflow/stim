import AppKit
import StimKit
import SwiftUI

struct TutorialPanel: View {
  var snapshot: TutorialSnapshot
  #if DEBUG
    var fixtureRendering = false
  #endif
  var message: TutorialNotice? = nil
  var issues: [StatusIssue] = []
  var phoneState = TutorialPhoneState(pairedPhoneCount: nil)
  var machineState = TutorialMachineState.none
  var canRunIOS = false
  var agentDeviceMissing = false
  var asks: (TutorialStep) -> String? = { $0.ask }
  var commands: (TutorialStep) -> String
  var copied: () -> Void = {}
  var skip: () -> Void = {}
  var markDone: () -> Void = {}
  var restart: () -> Void = {}
  var runIOS: () -> Void = {}
  var close: () -> Void = {}
  var openArchived: () -> Void = {}
  var pairPhone: () -> Void = {}
  var addMachine: () -> Void = {}
  var updateCLI: () -> Void = {}
  @State private var expanded: String?
  @State private var collapsedOptional: Set<String> = []
  @AppStorage("tutorial.commandsExpanded") private var commandsExpanded = false
  @ObservedObject private var updater = AppUpdater.shared
  @ObservedObject private var flags = FeatureFlagStore.shared
  private var steps: [TutorialStep] { TutorialSteps.steps(phoneApp: flags.phoneApp) }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        SectionLabel(title: "Stim tutorial")
        Spacer()
        Text("\(position) of \(steps.count)")
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
    .tint(Palette.primary)
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
      if snapshot.isComplete {
        Label("Tutorial Complete", systemImage: "checkmark.circle.fill")
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
      ForEach(steps, id: \.id) { step in
        if let state = snapshot.steps.first(where: { $0.id == step.id }) {
          stepRow(step, state: state).id(step.id)
        }
      }
    }
    .padding(Space.xl)
  }

  private var position: Int {
    snapshot.currentStep.flatMap { id in steps.firstIndex { $0.id == id }.map { $0 + 1 } }
      ?? steps.count
  }

  private func stepRow(_ step: TutorialStep, state: TutorialStepProgress) -> some View {
    let current = snapshot.currentStep == step.id
    let open =
      (current || expanded == step.id || (step.optional && state.state == .done && !collapsedOptional.contains(step.id)))
    return VStack(alignment: .leading, spacing: Space.md) {
      Button {
        if step.optional, state.state == .done {
          if expanded == step.id { expanded = nil }
          if collapsedOptional.contains(step.id) {
            collapsedOptional.remove(step.id)
          } else {
            collapsedOptional.insert(step.id)
          }
        } else {
          expanded = expanded == step.id ? nil : step.id
        }
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
      .accessibilityLabel("\(step.title), \(current ? message?.text ?? stateLabel(state.state) : stateLabel(state.state))")
      .accessibilityValue(open ? "Expanded" : "Collapsed")
      if open {
        VStack(alignment: .leading, spacing: Space.md) {
          Text(explanation(step.id)).foregroundStyle(Palette.secondary)
          copyBlock(step)
          if step.id == "build", agentDeviceMissing { AgentDeviceCard(copied: copied) }
          if step.id == "machine", machineState.showsPrompt {
            if snapshot.record.approvedMachine == nil {
              Text("Name the approved machine to your agent when you paste this prompt.")
                .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
            }
          }
          if step.id == "phone", snapshot.record.phonePairedAtStart == true {
            Text(phoneState.buttonTitle).font(.stim(.footnote)).foregroundStyle(Palette.success)
          }
          let notice = (current ? message : nil) ?? TutorialNotice(state.detail, action: state.action)
          let detail = notice.text
          if !detail.isEmpty, detail != explanation(step.id), current || ["build", "parallel", "phone"].contains(step.id) {
            Text(detail).foregroundStyle(color(state.state)).textSelection(.enabled)
          }
          switch notice.action {
          case .updateDesktop:
            Button("Check for Updates", action: updater.checkForUpdates)
              .buttonStyle(.stim()).disabled(!updater.canCheckForUpdates)
              .accessibilityLabel("Check for Stim Desktop updates")
          case .updateCLI:
            Button("Update Stim CLI", action: updateCLI).buttonStyle(.stim())
              .accessibilityLabel("Open the setup guide to update Stim CLI")
          case .restart:
            Button("Restart Tutorial", action: restart).buttonStyle(.stim())
              .accessibilityLabel("Restart the Stim tutorial")
          case nil: EmptyView()
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
            if step.id == "build" {
              Button {
                runIOS()
              } label: {
                Label("Run iOS", systemImage: "play.fill")
              }
              .buttonStyle(.stim(.primary)).disabled(!canRunIOS)
              .help(
                "stim ios --remote local --remote-build local: builds here if needed, installs and launches in this "
                  + "workspace"
              )
              .accessibilityLabel("Run the tutorial app on iOS")
            }
            if step.id == "phone", phoneState != .paired {
              Button(phoneState.buttonTitle, action: pairPhone).buttonStyle(.stim(.primary))
            }
            if step.id == "machine", !machineState.showsPrompt {
              Button(machineState.buttonTitle, action: addMachine)
                .buttonStyle(.stim(machineState.skipIsPrimary ? .secondary : .primary))
            }
            if step.optional {
              Button("Skip", action: skip)
                .buttonStyle(.stim(step.id == "machine" && machineState.skipIsPrimary ? .primary : .secondary))
                .accessibilityLabel("Skip \(step.title)")
            }
            if state.canMarkDone {
              Button("Mark Done", action: markDone).buttonStyle(.stim())
                .accessibilityLabel("Mark \(step.title) done")
            }
          }
        }
        .padding(.leading, Space.xl)
      } else if state.state == .done, ["build", "parallel"].contains(step.id), !state.detail.isEmpty {
        Text(state.detail).font(.stim(.caption)).foregroundStyle(Palette.tertiary).padding(.leading, Space.xl)
      }
    }
  }

  @ViewBuilder private func copyBlock(_ step: TutorialStep) -> some View {
    let ask = step.id == "machine" && !machineState.showsPrompt ? nil : asks(step)
    let hasCommands = !step.commands.isEmpty && (step.id != "machine" || machineState.showsPrompt)
    let showsAsk = ask != nil
    if let ask, showsAsk {
      TutorialPromptBox(prompt: ask, onCopy: copied)
    }
    if hasCommands {
      DisclosureGroup(isExpanded: $commandsExpanded) {
        VStack(alignment: .leading, spacing: Space.sm) {
          Text(showsAsk ? "Your agent runs these. You can also run them yourself." : "Run these yourself.")
            .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
          commandBlock(step)
        }
        .padding(.top, Space.sm)
      } label: {
        Text(showsAsk ? "Commands your agent will run" : "Commands to run yourself")
          .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      }
      .accessibilityLabel("Commands for \(step.title)")
    }
  }

  @ViewBuilder private func commandBlock(_ step: TutorialStep) -> some View {
    if rendersStatic {
      CommandBlock(commandText: commands(step))
        .fixedSize(horizontal: false, vertical: true)
        .frame(height: 280, alignment: .top).clipped()
    } else {
      ScrollView { CommandBlock(commandText: commands(step)) }
        .frame(maxHeight: 280)
    }
  }

  private var footer: some View {
    HStack {
      if !snapshot.isComplete {
        Button("Skip Step", action: skip).buttonStyle(.stim(.plain)).accessibilityLabel("Skip current tutorial step")
      }
      Spacer()
      if rendersStatic {
        Image(systemName: "ellipsis").accessibilityLabel("Tutorial options")
      } else {
        Menu {
          Button("Restart Tutorial", action: restart)
          Button("Close Tutorial", action: close)
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
    case "begin":
      return
        "You will see two agents work on two changes at once, each in its own worktree with its own simulator and dev server, each checking its own work on the device. First, clone the test app; the clone stays as the base and is never run or removed."
    case "build":
      return
        "Ask your agent for a visual change in your own words, for example: \"Make the title purple and check it on the simulator.\" It works in its own worktree with its own simulator and Metro, and checks the result on the device. Stim waited until the app said it was ready, not just launched, so the agent knows the app works before it checks the change: look for the readiness phase in the build details. On a fresh Mac this build is usually a cache miss and takes a few minutes. Watch it in Desktop."
    case "parallel":
      return
        "While that runs, ask for another change, for example: \"Try a dark background and check it on the simulator.\" Two worktrees run side by side with no port or simulator clash, and the second build is a cache hit, so isolation is cheap and it finishes much faster. Look at the cache badge and both simulators."
    case "device": return "Optional. Open the live view of either simulator and tap around while your agents work."
    case "agent":
      return
        "Optional. Your agent verifies UI changes itself with screenshots, taps and logs. Desktop shows what it did and lets you replay it. Apps can declare readiness with two log lines (stim guide lifecycle readiness), so agents can check their own apps the same way. Try a prompt like this, then watch Agent actions."
    case "logs": return "Optional. Agents read the logs too. Open Logs to see the app's output and any errors."
    case "phone":
      return
        "Optional. Pair a phone from Settings > Phones, then open Stim on it to see these workspaces. You can skip this step."
    case "machine":
      return "Optional. An approved Mac can build the same app. Choose one in Settings > Remote Macs, or skip this step."
    case "share":
      return
        "Optional and public, and do it before finishing so your change still exists. If you paste this, your agent forks appandflow/stim-tutorial and opens a pull request: your GitHub name and change appear on that repo. It needs GitHub access (gh) for your agent, and a bot will reply and close it. Nothing depends on this step."
    case "finish":
      return
        "Your agent stops the apps and removes the two worktrees and drops their changes. Their builds, logs and agent actions stay under Archived."
    default: return ""
    }
  }

  private func tickTitle(_ id: String) -> String {
    switch id {
    case "opened": return "Live view opened"
    case "input": return "Device controlled"
    case "action": return "Agent action received"
    case "stopped": return "Workspace stopped"
    case "archived": return "Worktree removed and archived"
    case "approved": return "Remote Mac approved"
    case "offloaded": return "Build ran on another Mac"
    default: return PhaseStep.name(id)
    }
  }
}

private struct TutorialPromptBox: View {
  var prompt: String
  var onCopy: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Text("Tell your agent:").font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      Card {
        VStack(alignment: .leading, spacing: Space.md) {
          Text(prompt).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
          HStack {
            Spacer()
            CopyButton(prompt, accessibilityLabel: "Copy prompt: \(prompt)", onCopy: onCopy)
          }
        }
        .padding(Space.lg)
      }
    }
  }
}

private struct AgentDeviceCard: View {
  var copied: () -> Void

  var body: some View {
    Card {
      VStack(alignment: .leading, spacing: Space.md) {
        Text("Let your agent see and test the app").font(.stim(.callout, weight: .semibold))
        Text(
          "agent-device lets it take screenshots and tap through the app, and Desktop shows what it did. Without it your agent can only check the build and logs. The tutorial completes either way."
        )
        .foregroundStyle(Palette.secondary)
        CommandBlock(commandText: "npm i -g agent-device")
        TutorialPromptBox(prompt: "Install agent-device and use it to check your change.", onCopy: copied)
      }
      .padding(Space.lg)
    }
  }
}
