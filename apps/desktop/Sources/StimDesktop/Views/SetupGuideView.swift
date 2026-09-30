import AppKit
import StimKit
import StimStores
import SwiftUI

/// The first-run setup guide: one screen per step, each showing what it found, the exact command its Run button
/// runs, and that command's output.
struct SetupGuideView: View {
  @ObservedObject var onboarding: Onboarding
  @EnvironmentObject private var actions: ActionCenter
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var step: SetupStep { onboarding.guideStep }
  private var setup: SetupChecks { onboarding.setup }
  private var busy: Bool { actions.active(for: Onboarding.actionKey) != nil }

  var body: some View {
    HStack(spacing: 0) {
      stepList
      Divider()
      VStack(spacing: 0) {
        ScrollViewReader { proxy in
          ScrollView {
            VStack(alignment: .leading, spacing: Space.xl) {
              SetupIllustration(step: step, complete: setup.isComplete)
              content
              Color.clear.frame(height: 0).id(Self.end)
            }
            .padding(.horizontal, Space.huge)
            .padding(.vertical, Space.xxl)
            .frame(maxWidth: .infinity, alignment: .leading)
            .id(step)
            .transition(
              reduceMotion
                ? .opacity
                : .asymmetric(
                  insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity))
          }
          .onChange(of: busy) { revealEnd(proxy) }
          .onChange(of: onboarding.projectFolder) { revealEnd(proxy) }
        }
        Divider()
        footer
      }
      .background(Palette.background)
    }
    .frame(width: 760, height: 620)
    .font(.stim(.body))
    .foregroundStyle(Palette.text)
    .tint(Palette.brand)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: step)
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
      if step == .notifications { onboarding.refreshNotifications() }
    }
  }

  private var stepList: some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      if let wordmark = BrandAssets.wordmark {
        Image(nsImage: wordmark)
          .resizable()
          .aspectRatio(contentMode: .fit)
          .frame(height: 22)
          .foregroundStyle(Palette.primary)
          .padding(.horizontal, Space.md)
          .padding(.bottom, Space.xl)
          .accessibilityLabel("Stim")
      }
      ForEach(SetupStep.allCases, id: \.self) { item in
        Button {
          onboarding.guideStep = item
        } label: {
          HStack(spacing: Space.md) {
            stateIcon(item).frame(width: 18)
            Text(item.title).font(.stim(.callout, weight: item == step ? .semibold : .regular))
            Spacer(minLength: 0)
          }
          .padding(.horizontal, Space.md)
          .frame(height: 30)
          .background(
            RoundedRectangle(cornerRadius: Radius.control).fill(item == step ? Palette.selection : .clear)
          )
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(item.title), \(stateDescription(item))")
        .accessibilityAddTraits(item == step ? .isSelected : [])
      }
      Spacer()
    }
    .padding(Space.lg)
    .padding(.top, Space.xl)
    .frame(width: 210)
    .background(Palette.sidebar)
  }

  @ViewBuilder private func stateIcon(_ item: SetupStep) -> some View {
    switch setup.state(of: item) {
    case .done:
      Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.success)
    case .pending:
      Image(systemName: "circle").foregroundStyle(Palette.tertiary)
    case .blocked:
      Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Palette.warning)
    case .checking:
      ProgressView().controlSize(.mini)
    case .notApplicable:
      Image(systemName: item == .done ? "flag.checkered" : item == .welcome ? "hand.wave" : "circle.dashed")
        .foregroundStyle(Palette.tertiary)
    }
  }

  private func stateDescription(_ item: SetupStep) -> String {
    switch setup.state(of: item) {
    case .done: return "done"
    case .pending: return "to do"
    case .blocked: return "needs attention"
    case .checking: return "checking"
    case .notApplicable: return item == .check ? "optional" : ""
    }
  }

  @ViewBuilder private var content: some View {
    switch step {
    case .welcome: welcome
    case .cli: cli
    case .skill: skill
    case .notifications: notifications
    case .check: check
    case .done: done
    }
  }

  private var welcome: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      heading("Welcome to Stim Desktop")
      Text(
        "Stim gives each React Native or Expo workspace its own Metro port and simulator or emulator, so coding agents can build and run your app side by side. This app shows every workspace, device and build Stim runs."
      )
      .foregroundStyle(Palette.secondary)
      Text(
        "A few steps get this Mac ready. Each one shows the command it runs, and nothing runs until you press Run. You can skip any step and come back from Help \u{203A} Setup Guide."
      )
      .foregroundStyle(Palette.secondary)
    }
  }

  private var cli: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      heading("Install the stim CLI")
      Text("Stim Desktop reads and drives your workspaces through the stim command-line tool. It needs Node.js 22.12 or later.")
        .foregroundStyle(Palette.secondary)
      nodeStatus
      stimStatus
      if setup.state(of: .cli) == .blocked {
        if setup.brewPath != nil {
          CommandBlock(
            command: onboarding.installNodeCommand, run: onboarding.guideRuns[onboarding.installNodeCommand], busy: busy,
            isDefault: true, caption: "Installs Node.js with Homebrew."
          ) { onboarding.runGuide("Install Node.js", onboarding.installNodeCommand) }
        } else {
          HStack(spacing: Space.md) {
            Link("Download Node.js", destination: URL(string: "https://nodejs.org/en/download")!)
              .buttonStyle(.stim(.primary))
            Button("Check Again") { onboarding.check() }.buttonStyle(.stim())
          }
        }
      } else {
        CommandBlock(
          command: onboarding.installCLICommand, run: onboarding.guideRuns[onboarding.installCLICommand], busy: busy,
          isDefault: setup.state(of: .cli) == .pending,
          caption: setup.stim.map { $0 == .missing ? "Installs stim for your user." : "Updates stim to the latest version." }
        ) { onboarding.runGuide("Install stim", onboarding.installCLICommand) }
      }
    }
  }

  @ViewBuilder private var nodeStatus: some View {
    switch setup.node {
    case nil:
      statusLine("Looking for Node.js\u{2026}", tone: .neutral, icon: nil)
    case .compatible(let version)?:
      statusLine("Node.js \(version)", tone: .success, icon: "checkmark.circle.fill")
    case .missing?:
      statusLine(
        "Node.js is not on your login shell's PATH." + (setup.brewPath == nil ? " Install it, then check again." : ""),
        tone: .warning, icon: "exclamationmark.triangle.fill")
    case .outdated(let found)?:
      statusLine(
        "Node.js \(found ?? "of an unknown version") is older than \(SetupChecks.nodeMinimum).", tone: .warning,
        icon: "exclamationmark.triangle.fill")
    }
  }

  @ViewBuilder private var stimStatus: some View {
    if let report = onboarding.report {
      switch report.stim {
      case .compatible(let version):
        VStack(alignment: .leading, spacing: Space.md) {
          HStack(spacing: Space.md) {
            statusLine(
              "stim \(version) at \(abbreviatingHome(report.stimPath ?? "stim"))", tone: .success,
              icon: "checkmark.circle.fill")
            Button("Choose Another\u{2026}", action: onboarding.chooseStim).buttonStyle(.stim(.plain))
          }
          if report.needsRelaunch {
            restartBanner("The app picks its stim when it starts. The guide reopens here.", action: onboarding.restartForSetup)
          }
        }
      case .outdated(let found):
        statusLine(
          "\(abbreviatingHome(report.stimPath ?? "stim")) reports \(found ?? "no version"); Stim Desktop needs \(StimCLI.minimumVersion) or later.",
          tone: .warning, icon: "exclamationmark.triangle.fill")
      case .missing:
        EmptyView()
      }
    }
  }

  private var skill: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      heading("Add the Stim skill to your coding agent")
      Text(
        "The skill tells Claude Code, Codex, Cursor and other agents to use Stim when they build, run or debug your app. It only points the agent at stim guide agent, so the guidance always matches the installed stim and upgrades need no reinstall."
      )
      .foregroundStyle(Palette.secondary)
      CommandBlock(
        command: onboarding.installSkillCommand, run: onboarding.guideRuns[onboarding.installSkillCommand], busy: busy,
        isDefault: setup.state(of: .skill) == .pending,
        caption: "Installs it for the agents on this Mac, in every project."
      ) { onboarding.runGuide("Install the Stim skill", onboarding.installSkillCommand) }
      if let path = setup.skillPath {
        statusLine("Installed at \(abbreviatingHome(path))", tone: .success, icon: "checkmark.circle.fill")
      }
    }
  }

  private var notifications: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      heading("Hear about it when something needs you")
      Text(
        "Stim Desktop can alert you when an agent or this Mac needs you. Alert shows a card in the Stim window, or a macOS notification when the window is in the background; Silent only lists it under Notifications in the sidebar."
      )
      .foregroundStyle(Palette.secondary)
      VStack(spacing: Space.sm) {
        ForEach(OversightCategory.desktop.filter(\.needsAttention), id: \.self) { category in
          OversightLevelPicker(category: category)
        }
      }
      .frame(maxWidth: 420)
      Text("More in Settings \u{203A} App \u{203A} Notify when.")
        .font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
      switch setup.notifications {
      case .notDetermined?:
        Button("Allow Notifications", action: onboarding.requestNotifications)
          .buttonStyle(.stim(.primary, .regular))
          .keyboardShortcut(.defaultAction)
      case .denied?:
        statusLine("Notifications are off for Stim Desktop.", tone: .warning, icon: "bell.slash.fill")
        Button("Open System Settings", action: onboarding.openNotificationSettings).buttonStyle(.stim(.primary))
      case .allowed?:
        statusLine("Notifications are on.", tone: .success, icon: "checkmark.circle.fill")
      case .unavailable?:
        statusLine("This build has no app bundle, so it cannot post notifications.", tone: .neutral, icon: "info.circle")
      case nil:
        EmptyView()
      }
    }
  }

  private var check: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      heading("Check your setup")
      Text(
        "Optional. Stim builds iOS apps with Xcode and Android apps with the Android SDK and a JDK. These read-only checks show what this Mac has."
      )
      .foregroundStyle(Palette.secondary)
      toolCheck(
        "Xcode", command: onboarding.xcodeCommand, found: MachineCheck.xcode,
        fix:
          "Install Xcode from the App Store. If it is installed, select it with sudo xcode-select --switch /Applications/Xcode.app."
      )
      VStack(alignment: .leading, spacing: Space.sm) {
        Text("Android").font(.stim(.callout, weight: .semibold))
        if let report = onboarding.report {
          if let sdk = report.androidSDK {
            statusLine("Android SDK at \(abbreviatingHome(sdk))", tone: .success, icon: "checkmark.circle.fill")
          } else {
            statusLine(
              "No Android SDK in ANDROID_HOME, ANDROID_SDK_ROOT or ~/Library/Android/sdk. Install Android Studio to get one.",
              tone: .warning, icon: "exclamationmark.triangle.fill")
          }
        }
        toolCheck(
          nil, command: onboarding.javaCommand, found: MachineCheck.java,
          fix: "Install a JDK, such as the one Android Studio ships, and set JAVA_HOME to it.")
        if let javaHome = onboarding.report?.javaHome {
          Text("Gradle uses JAVA_HOME: \(abbreviatingHome(javaHome))").font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
        }
      }
      Divider().padding(.vertical, Space.xs)
      projectCheck
    }
  }

  private func toolCheck(
    _ title: String?, command: StimCommand, found: (String) -> String?, fix: String
  ) -> some View {
    let run = onboarding.guideRuns[command]
    let output = run.map { $0.lines.map(\.text).joined(separator: "\n") } ?? ""
    return VStack(alignment: .leading, spacing: Space.sm) {
      if let title { Text(title).font(.stim(.callout, weight: .semibold)) }
      CommandBlock(
        command: command, run: run, busy: busy, isDefault: false, caption: nil, showsOutput: false,
        showsDirectory: false
      ) {
        onboarding.runGuide("Check \(command.program)", command)
      }
      if let run, !run.isRunning {
        if run.exitStatus == 0, let version = found(output) {
          statusLine(version, tone: .success, icon: "checkmark.circle.fill")
        } else {
          statusLine(
            (run.launchError ?? output.split(whereSeparator: \.isNewline).first.map(String.init) ?? "Failed.") + " " + fix,
            tone: .warning, icon: "exclamationmark.triangle.fill")
        }
      }
    }
  }

  private var projectCheck: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      Text("Check a project").font(.stim(.callout, weight: .semibold))
      Text(
        "stim doctor reports what a React Native or Expo project needs for fast worktrees and builds, with the fix for each finding. It changes nothing."
      )
      .foregroundStyle(Palette.secondary)
      HStack(spacing: Space.md) {
        Button(onboarding.projectFolder == nil ? "Choose Project Folder\u{2026}" : "Choose Another\u{2026}") {
          onboarding.chooseProjectFolder()
        }
        .buttonStyle(.stim())
        if let folder = onboarding.projectFolder {
          Label(abbreviatingHome(folder), systemImage: "folder")
            .lineLimit(1).truncationMode(.middle).foregroundStyle(Palette.secondary)
        }
      }
      .disabled(!onboarding.runsStim)
      if !onboarding.runsStim {
        statusLine(
          onboarding.report?.stim.isCompatible == true
            ? "Restart Stim Desktop to use the stim you installed." : "Install the stim CLI first.",
          tone: .neutral, icon: "info.circle")
      } else if let folder = onboarding.projectFolder {
        let command = Onboarding.doctorCommand(in: folder)
        CommandBlock(command: command, run: onboarding.guideRuns[command], busy: busy, isDefault: true, caption: nil) {
          onboarding.runGuide("Check \((folder as NSString).lastPathComponent)", command)
        }
      }
    }
  }

  private var done: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      heading(setup.isComplete ? "You're set" : "Almost there")
      Text(
        setup.isComplete
          ? "Ask your coding agent to run your app, and its workspace shows up here."
          : "Some steps are still open. You can finish them later from Help \u{203A} Setup Guide."
      )
      .foregroundStyle(Palette.secondary)
      VStack(alignment: .leading, spacing: Space.sm) {
        ForEach([SetupStep.cli, .skill, .notifications], id: \.self) { item in
          Button {
            onboarding.guideStep = item
          } label: {
            HStack(spacing: Space.md) {
              stateIcon(item).frame(width: 18)
              Text(item.title)
            }
          }
          .buttonStyle(.plain)
          .accessibilityLabel("\(item.title), \(stateDescription(item))")
        }
      }
      if onboarding.report?.needsRelaunch == true {
        restartBanner("The app picks its stim when it starts.", action: onboarding.finishAndRestart)
      }
    }
  }

  private var footer: some View {
    HStack(spacing: Space.md) {
      if step != .done {
        Button("Set Up Later", action: onboarding.finishGuide)
          .buttonStyle(.stim(.plain))
          .keyboardShortcut(.cancelAction)
          .help("Close the guide. Reopen it from Help \u{203A} Setup Guide.")
      }
      Spacer()
      if let previous = step.previous {
        Button("Back") { onboarding.guideStep = previous }.buttonStyle(.stim())
      }
      if let next = step.next {
        let finished = [.done, .notApplicable].contains(setup.state(of: step))
        Button(step == .welcome ? "Get Started" : finished ? "Continue" : "Skip") { onboarding.guideStep = next }
          .buttonStyle(.stim(finished || step == .welcome ? .primary : .secondary, .regular))
          .keyboardShortcut(hasDefaultAction ? nil : .defaultAction)
      } else {
        Button("Start Using Stim", action: onboarding.finishGuide)
          .buttonStyle(.stim(.primary, .regular))
          .keyboardShortcut(.defaultAction)
      }
    }
    .padding(.horizontal, Space.xxl)
    .padding(.vertical, Space.lg)
  }

  /// Whether the screen itself holds the button Return presses: a Run button or a permission request.
  private var hasDefaultAction: Bool {
    switch step {
    case .cli:
      let state = setup.state(of: .cli)
      return state == .pending || (state == .blocked && setup.brewPath != nil)
    case .skill: return setup.state(of: .skill) == .pending
    case .notifications: return setup.notifications == .notDetermined
    case .check: return onboarding.runsStim && onboarding.projectFolder != nil
    default: return false
    }
  }

  private static let end = "end"

  /// Scrolls to a command's output when it starts and to its result when it ends.
  private func revealEnd(_ proxy: ScrollViewProxy) {
    DispatchQueue.main.async {
      withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(Self.end, anchor: .bottom) }
    }
  }

  private func restartBanner(_ detail: String, action: @escaping () -> Void) -> some View {
    Banner(tone: .accent, icon: "arrow.clockwise") {
      Text("Restart Stim Desktop to use this stim.").font(.stim(.callout, weight: .semibold))
      Text(detail).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
    } trailing: {
      if onboarding.canRelaunch {
        Button("Restart", action: action).buttonStyle(.stim(.primary))
      }
    }
  }

  private func heading(_ text: String) -> some View {
    Text(text).font(.stim(.title)).accessibilityAddTraits(.isHeader)
  }

  private func statusLine(_ text: String, tone: Tone, icon: String?) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
      if let icon { Image(systemName: icon).foregroundStyle(Color(tone)) }
      Text(text).foregroundStyle(tone == .neutral ? Palette.secondary : Palette.text)
    }
    .font(.stim(.callout))
    .accessibilityElement(children: .combine)
  }
}

/// A command as the guide runs it, with its Run button, and the output of its last run.
private struct CommandBlock: View {
  var command: StimCommand
  var run: ActionRun?
  var busy: Bool
  var isDefault: Bool
  var caption: String?
  var showsOutput = true
  var showsDirectory = true
  var start: () -> Void
  @State private var copied = false

  private var text: String { ([command.program] + command.arguments).joined(separator: " ") }
  private var matchingRun: ActionRun? { run }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      HStack(spacing: Space.md) {
        Text(text)
          .font(.stim(.callout, mono: true))
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
        Button {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(text, forType: .string)
          copied = true
        } label: {
          Image(systemName: copied ? "checkmark" : "doc.on.doc")
        }
        .buttonStyle(.stim(.plain))
        .help("Copy the command")
        .accessibilityLabel(copied ? "Copied" : "Copy \(text)")
        runButton
      }
      .padding(.leading, Space.lg)
      .padding(.trailing, Space.sm)
      .padding(.vertical, Space.sm)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
      .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Palette.border))
      let line = [caption, showsDirectory ? "Runs in \(abbreviatingHome(command.cwd))." : nil].compactMap { $0 }
      if !line.isEmpty {
        Text(line.joined(separator: " ")).font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
      }
      if showsOutput, let matchingRun { RunOutput(run: matchingRun) }
    }
  }

  @ViewBuilder private var runButton: some View {
    let running = matchingRun?.isRunning == true
    let failed = matchingRun?.needsAttention == true
    let succeeded = matchingRun?.exitStatus == 0
    Button(action: start) {
      HStack(spacing: Space.xs) {
        if running {
          ProgressView().controlSize(.small)
          Text("Running")
        } else {
          Image(systemName: failed ? "arrow.clockwise" : "play.fill")
          Text(failed ? "Retry" : succeeded ? "Run Again" : "Run")
        }
      }
    }
    .buttonStyle(.stim(.primary, .regular))
    .disabled(busy)
    .keyboardShortcut(isDefault && !busy ? .defaultAction : nil)
    .accessibilityLabel(running ? "Running \(text)" : "\(failed ? "Retry" : succeeded ? "Run again" : "Run") \(text)")
  }
}

private struct RunOutput: View {
  @ObservedObject var run: ActionRun

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(run.logLines.suffix(400).enumerated()), id: \.offset) { index, line in
              Text(line.text.isEmpty ? " " : line.text)
                .font(.stim(.caption, mono: true))
                .foregroundStyle(Media.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .id(index)
            }
          }
          .padding(Space.md)
          .textSelection(.enabled)
        }
        .frame(height: 100)
        .background(RoundedRectangle(cornerRadius: Radius.control).fill(Media.screen))
        .onChange(of: run.logLines.count) {
          proxy.scrollTo(min(run.logLines.count, 400) - 1, anchor: .bottom)
        }
      }
      .accessibilityLabel("Command output")
      result
    }
  }

  @ViewBuilder private var result: some View {
    if let error = run.launchError {
      Label(error, systemImage: "xmark.octagon.fill").foregroundStyle(Palette.error)
    } else if let status = run.exitStatus {
      if status == 0 {
        Label("Finished", systemImage: "checkmark.circle.fill").foregroundStyle(Palette.success)
      } else {
        Label("Failed with exit status \(status). Check the output above, then retry.", systemImage: "xmark.octagon.fill")
          .foregroundStyle(Palette.error)
      }
    }
  }
}
