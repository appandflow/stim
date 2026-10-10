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
  var agentDeviceMissing = false
  var asks: (TutorialStep) -> String? = { $0.ask }
  var copied: () -> Void = {}
  var next: () -> Void = {}
  var restart: () -> Void = {}
  var close: () -> Void = {}
  var openArchived: () -> Void = {}
  var openBuild: (() -> Void)? = nil
  var pairPhone: () -> Void = {}
  var updateCLI: () -> Void = {}
  @State private var expanded: String?
  @State private var collapsedOptional: Set<String> = []
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
      .padding([.horizontal, .top], Space.xl)
      TutorialTrack(steps: steps, progress: snapshot.steps)
        .padding(.horizontal, Space.xl)
        .padding(.vertical, Space.md)
      illustration
        .padding(.horizontal, Space.lg)
        .padding(.bottom, Space.md)
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

  @ViewBuilder private var illustration: some View {
    let step = snapshot.currentStep ?? (snapshot.record.done.contains("delete") ? "delete" : "finish")
    let state = snapshot.steps.first { $0.id == step }?.state
    let failed: Bool = {
      if case .failed = state { return true }
      return false
    }()
    #if DEBUG
      TutorialIllustration(step: step, failed: failed, fixtureRendering: fixtureRendering)
    #else
      TutorialIllustration(step: step, failed: failed)
    #endif
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
      if snapshot.isFinished {
        TutorialCompletionCard(
          snapshot: snapshot, steps: steps,
          archiveOff: snapshot.steps.first(where: { $0.id == "finish" })?.detail == "Archived is off",
          openArchived: openArchived)
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
          if let ask = asks(step) { TutorialPromptBox(prompt: ask, onCopy: copied) }
          if step.id == "build", current, let openBuild {
            HStack(spacing: Space.sm) {
              Text("Click Show to watch the build.")
              Button("Open the build", action: openBuild).buttonStyle(.link).foregroundStyle(Palette.primary)
                .accessibilityLabel("Open the tutorial build")
            }
          }
          if step.id == "build", agentDeviceMissing { AgentDeviceCard(copied: copied) }
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
              Self.tickTitle(tick.id) + (tick.optional ? " (optional)" : ""),
              systemImage: tick.done ? "checkmark.circle.fill" : "circle"
            )
            .font(.stim(.footnote)).foregroundStyle(tick.done ? Palette.success : Palette.secondary)
            .accessibilityLabel("\(Self.tickTitle(tick.id)), \(tick.done ? "done" : "waiting")")
          }
          if let pull = state.link, let url = URL(string: pull.url) {
            Link("PR #\(pull.number): \(pull.title)", destination: url).lineLimit(1)
              .accessibilityLabel("Open pull request \(pull.number)")
          }
          if current {
            ForEach(issues, id: \.self) { issue in
              Text("\(issue.code): \(issue.message) \(issue.remedy)").foregroundStyle(Palette.warning)
                .textSelection(.enabled)
            }
            if step.id == "phone", phoneState != .paired {
              Button(phoneState.buttonTitle, action: pairPhone).buttonStyle(.stim(.primary))
            }
            Button("Next", action: next).buttonStyle(.stim(.secondary))
              .accessibilityLabel("Next: leave \(step.title)")
          }
        }
        .padding(.leading, Space.xl)
      } else if state.state == .done, ["build", "parallel"].contains(step.id), !state.detail.isEmpty {
        Text(state.detail).font(.stim(.caption)).foregroundStyle(Palette.tertiary).padding(.leading, Space.xl)
      }
    }
  }

  private var footer: some View {
    HStack {
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
        "Watch two agents make two changes at once, each in its own worktree with its own simulator and dev server, checking its own work on the device. First, clone the test app."
    case "build":
      return
        "Ask your agent for a visual change. It builds in its own worktree and simulator, and checks the result on the device. The first build can take a few minutes."
    case "parallel":
      return
        "While that builds, ask for a second change in a new worktree. Two worktrees run side by side with no port or simulator clash, and the second build is a cache hit, so isolation is cheap and it finishes much faster. Look at the cache badge and both simulators."
    case "device": return "Open a tutorial simulator's live view and tap the app yourself."
    case "agent": return "See what your agent did on the device, then replay it."
    case "logs": return "Optional. Agents read the logs too. Open Logs to see the app's output and any errors."
    case "phone":
      return
        "Optional. Pair a phone from Settings > Phones, then open Stim on it to see these workspaces. You can skip this step."
    case "share":
      return
        "Your agent opens a public PR on appandflow/stim-tutorial with before/after screenshots. Needs gh access. Do it before Finish."
    case "finish":
      return
        "Your agent stops the apps and removes the two worktrees and drops their changes. Their builds, logs and agent actions stay under Archived."
    case "delete":
      return
        "Optional. Your agent removes any tutorial worktrees left and then the clone, through Stim so their simulators and dev servers go too, and deletes the folder. Press Next to keep the clone."
    default: return ""
    }
  }

  static func tickTitle(_ id: String) -> String {
    switch id {
    case "opened": return "Live view opened"
    case "input": return "Device controlled"
    case "viewed": return "Agent actions viewed"
    case "replayed": return "Replay played"
    case "stopped": return "Workspace stopped"
    case "archived": return "Worktree removed and archived"
    case "cloned": return "Test app cloned"
    case "installed": return "Dependencies installed"
    case "registered": return "Registered with Stim"
    case "worktrees": return "Tutorial worktrees removed"
    case "clone": return "Clone removed and deleted"
    case "pr": return "Pull request opened"
    case "logs": return "Logs opened"
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
