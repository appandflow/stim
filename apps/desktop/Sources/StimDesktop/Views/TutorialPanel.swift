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
  var openAgentActions: (() -> Void)? = nil
  var openLogs: (() -> Void)? = nil
  var pairPhone: () -> Void = {}
  var updateCLI: () -> Void = {}
  @State private var viewed: String?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.isEnabled) private var isEnabled
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
        Button(action: close) {
          Image(systemName: "xmark")
        }
        .buttonStyle(.plain)
        .foregroundStyle(Palette.secondary)
        .help("Close Tutorial")
        .accessibilityLabel("Close Tutorial")
      }
      .padding([.horizontal, .top], Space.xl)
      HStack(spacing: Space.sm) {
        arrow("chevron.left", to: slides.previous(shown), label: "Previous step")
        TutorialTrack(
          steps: steps, progress: snapshot.steps, finished: snapshot.isFinished, viewed: shown, select: view)
        arrow("chevron.right", to: slides.next(shown), label: "Next step")
      }
      .padding(.horizontal, Space.lg)
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
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Stim tutorial")
    .focusable()
    .focusEffectDisabled()
    .onKeyPress(.leftArrow) {
      guard isEnabled else { return .ignored }
      guard let id = slides.previous(shown) else { return .ignored }
      view(id)
      return .handled
    }
    .onKeyPress(.rightArrow) {
      guard isEnabled else { return .ignored }
      guard let id = slides.next(shown) else { return .ignored }
      view(id)
      return .handled
    }
    .onChange(of: slides.current) { old, _ in
      withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) {
        viewed = slides.viewed(viewed, afterProgressFrom: old)
      }
    }
  }

  private var slides: TutorialSlides {
    TutorialSlides(steps: steps.map(\.id), currentStep: snapshot.currentStep, finished: snapshot.isFinished)
  }

  private var shown: String { slides.shown(viewed) }

  private func view(_ id: String) {
    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.25)) {
      viewed = id == slides.current ? nil : id
    }
  }

  private func arrow(_ symbol: String, to target: String?, label: String) -> some View {
    Button {
      if let target { view(target) }
    } label: {
      Image(systemName: symbol).frame(width: 16, height: 22).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .foregroundStyle(target == nil ? Palette.tertiary : Palette.secondary)
    .disabled(target == nil)
    .help(label)
    .accessibilityLabel(target.map { "\(label): \(title(of: $0))" } ?? label)
  }

  private func title(of id: String) -> String {
    id == TutorialSlides.completion ? "Tutorial complete" : steps.first { $0.id == id }?.title ?? id
  }

  @ViewBuilder private var illustration: some View {
    let step =
      shown == TutorialSlides.completion ? (snapshot.record.done.contains("delete") ? "delete" : "finish") : shown
    let state = shown == slides.current ? snapshot.steps.first { $0.id == step }?.state : nil
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
      slide.frame(maxHeight: .infinity, alignment: .top)
    } else {
      ScrollView { slide }
    }
  }

  private var slide: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      if shown != slides.current {
        Button("Go to Current Step") { view(slides.current) }
          .buttonStyle(.stim(.secondary))
          .accessibilityLabel("Go to the current step: \(title(of: slides.current))")
      }
      if shown == TutorialSlides.completion {
        TutorialCompletionCard(
          snapshot: snapshot, steps: steps,
          archiveOff: snapshot.steps.first(where: { $0.id == "finish" })?.detail == "Archived is off",
          openArchived: openArchived, restart: restart)
      } else if let step = steps.first(where: { $0.id == shown }),
        let state = snapshot.steps.first(where: { $0.id == shown })
      {
        let ahead = slides.isAhead(step.id)
        stepRow(step, state: state)
          .opacity(ahead ? 0.55 : 1)
          .disabled(ahead)
          .accessibilityHint(ahead ? "A later step, read-only until you reach it" : "")
      }
    }
    .id(shown)
    .transition(reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .trailing), removal: .opacity))
    .padding(Space.xl)
  }

  private var position: Int {
    steps.firstIndex { $0.id == shown }.map { $0 + 1 } ?? steps.count
  }

  private func stepRow(_ step: TutorialStep, state: TutorialStepProgress) -> some View {
    let current = snapshot.currentStep == step.id
    return VStack(alignment: .leading, spacing: Space.md) {
      HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
        Image(systemName: icon(state.state)).foregroundStyle(color(state.state)).frame(width: 16)
        Text(step.title).font(.stim(.headline))
        Spacer(minLength: 0)
        if step.optional { Text("Optional").font(.stim(.caption)).foregroundStyle(Palette.tertiary) }
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel("\(step.title), \(current ? message?.text ?? stateLabel(state.state) : stateLabel(state.state))")
      .accessibilityAddTraits(.isHeader)
      VStack(alignment: .leading, spacing: Space.md) {
        Text(explanation(step.id)).foregroundStyle(Palette.secondary)
        if current, let ask = asks(step) { TutorialPromptBox(prompt: ask, onCopy: copied) }
        if ["build", "parallel"].contains(step.id), current, let openBuild {
          HStack(spacing: Space.sm) {
            Text("Click Show to watch the build.")
            Button("Open the build", action: openBuild).buttonStyle(.link).foregroundStyle(Palette.primary)
              .accessibilityLabel("Open the tutorial build")
          }
        }
        if step.id == "build", agentDeviceMissing { AgentDeviceCard(copied: copied) }
        if current, step.id == "agent", let openAgentActions {
          Button("Open Agent Actions", action: openAgentActions).buttonStyle(.stim(.primary))
            .accessibilityLabel("Open Agent Actions for the tutorial simulator")
        }
        if current, step.id == "logs", let openLogs {
          Button("Open Logs", action: openLogs).buttonStyle(.stim(.primary))
            .accessibilityLabel("Open Logs for the tutorial workspace")
        }
        if step.id == "phone", snapshot.record.phonePairedAtStart == true {
          Text(phoneState.buttonTitle).font(.stim(.footnote)).foregroundStyle(Palette.success)
        }
        if state.state == .done, let warning = state.warning {
          Label(warning, systemImage: "exclamationmark.triangle.fill").font(.stim(.caption))
            .foregroundStyle(Palette.warning)
        }
        let notice = (current ? message : nil) ?? TutorialNotice(state.detail, action: state.action)
        let detail = notice.text
        if current, state.state == .current, notice.action == nil {
          let waitingText =
            detail == "Waiting for the tutorial workspace..."
            ? "Waiting for your agent to clone the app..."
            : detail.isEmpty ? "Waiting for this step to finish..." : detail
          HStack(alignment: .top, spacing: Space.sm) {
            if reduceMotion {
              Image(systemName: "hourglass").foregroundStyle(Palette.accent)
            } else {
              ProgressView().controlSize(.small).tint(Palette.accent)
            }
            Text(waitingText)
              .font(.stim(.callout, weight: .medium))
              .fixedSize(horizontal: false, vertical: true)
              .textSelection(.enabled)
          }
        } else if !detail.isEmpty, detail != explanation(step.id), current || ["build", "parallel", "phone"].contains(step.id) {
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
          let active = current && tick.id == state.ticks.first(where: { !$0.done })?.id
          Label {
            Text(Self.tickTitle(tick.id) + (tick.optional ? " (optional)" : ""))
              .foregroundStyle(tick.done ? Palette.secondary : active ? Palette.text : Palette.tertiary)
          } icon: {
            Image(systemName: tick.done ? "checkmark.circle.fill" : "circle")
              .foregroundStyle(tick.done ? Palette.success : active ? Palette.accent : Palette.tertiary)
          }
          .font(.stim(.footnote))
          .accessibilityLabel("\(Self.tickTitle(tick.id)), \(tick.done ? "done" : "waiting")")
        }
        if let pull = state.link, let url = URL(string: pull.url) {
          Link("PR #\(pull.number): \(pull.title)", destination: url).lineLimit(1)
            .accessibilityLabel("Open pull request \(pull.number)")
        }
        if current {
          ForEach(TutorialIssues.shown(issues, step: step.id), id: \.self) { issue in
            TutorialIssueRow(issue: issue)
          }
          if step.id == "phone", phoneState != .paired {
            Button(phoneState.buttonTitle, action: pairPhone).buttonStyle(.stim(.primary))
          }
          HStack {
            Spacer()
            Button("Skip step", action: next)
              .buttonStyle(.plain)
              .foregroundStyle(Palette.primary)
              .accessibilityLabel("Skip \(step.title)")
          }
        }
      }
      .padding(.leading, 16 + Space.sm)
    }
  }

  private var footer: some View {
    HStack {
      Button("Restart Tutorial", action: restart)
        .buttonStyle(.stim(.secondary))
      Spacer()
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
        "Run two agents side by side with Stim. Have each agent change the test app and test its work on a separate simulator. Clone the test app to get started."
    case "build":
      return
        "Ask your agent for a visual change. It builds in its own worktree and simulator, and checks the result on the device. The first build can take a few minutes."
    case "parallel":
      return
        "While that builds, ask for a second change in a new worktree. Two worktrees run side by side with no port or simulator clash, and the second build is a cache hit, so isolation is cheap and it finishes much faster. Look at the cache badge and both simulators."
    case "device": return "Open a tutorial simulator's live view and tap the app yourself."
    case "agent": return "Open Agent Actions to see what your agent did, then press Play to replay it."
    case "logs": return "Open Logs to see your app's output and errors."
    case "phone":
      return "Pair a phone from Settings > Phones, then open Stim on it to see these workspaces. You can skip this step."
    case "share":
      return
        "Your agent opens a public PR on appandflow/stim-tutorial with before/after screenshots. Needs gh access. Do it before Finish."
    case "finish":
      return
        "Ask your agent to stop both apps and remove their worktrees, discarding the experimental changes. Keep the test app's clone for later. If archiving is enabled, you can review the saved builds, logs, and agent actions in Archived."
    case "delete": return "Delete the test app's clone, or skip this step to keep it."
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
          Text(prompt)
            .textSelection(.enabled)
            .lineLimit(nil)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
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

private struct TutorialIssueRow: View {
  var issue: StatusIssue

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      Label(TutorialIssues.sentence(issue.message), systemImage: "exclamationmark.triangle.fill")
        .foregroundStyle(issue.severity == "error" ? Palette.error : Palette.warning)
        .textSelection(.enabled)
      if !issue.remedy.isEmpty {
        HStack(spacing: Space.sm) {
          Text(issue.remedy).font(.stim(.footnote, mono: true)).textSelection(.enabled)
          CopyButton(issue.remedy, accessibilityLabel: "Copy fix: \(issue.remedy)")
        }
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
