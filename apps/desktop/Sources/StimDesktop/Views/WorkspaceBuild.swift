import StimKit
import SwiftUI

/// The last lines `stim logs --source build` printed for a slot since a build started.
@MainActor
final class BuildOutputModel: ObservableObject {
  @Published private(set) var lines: [LogRecord] = []
  private var since: Date = .distantPast
  private var limit = 1
  private lazy var follower = LogFollower { [weak self] event in self?.handle(event) }

  func start(cli: StimCLI, workspace: String, slot: String, since: Date, limit: Int) {
    self.since = since
    self.limit = limit
    lines = []
    var query = LogQuery()
    query.sources = [.build]
    query.slot = slot
    query.tail = 50
    follower.start(query, cli: cli, cwd: workspace)
  }

  func stop() {
    follower.stop()
    lines = []
  }

  private func handle(_ event: LogFollower.Event) {
    guard case .records(let batch) = event else { return }
    let fresh = batch.filter { $0.date >= since }
    guard !fresh.isEmpty else { return }
    lines = Array((lines + fresh).suffix(limit))
  }
}

/// Follows the build output of `build` while the view is on screen.
struct BuildOutputTail: View {
  var cli: Task<StimCLI, Never>
  var workspace: String
  var build: Build
  var limit: Int
  @StateObject private var model = BuildOutputModel()

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      ForEach(Array(model.lines.enumerated()), id: \.offset) { _, record in
        Text(record.msg)
          .font(.stim(.caption, mono: true))
          .foregroundStyle(record.level >= .error ? Palette.error : Palette.tertiary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
    }
    .task(id: "\(workspace)|\(build.slot)|\(build.startedAt)") {
      let cli = await cli.value
      guard !Task.isCancelled else { return }
      let started =
        ISO8601DateFormatter.fractional.date(from: build.startedAt) ?? ISO8601DateFormatter().date(from: build.startedAt)
      model.start(cli: cli, workspace: workspace, slot: build.slot, since: started ?? .distantPast, limit: limit)
    }
    .onDisappear { model.stop() }
  }
}

extension ISO8601DateFormatter {
  static let fractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
}

/// Replaces the Build card while a build runs: the phase and its counts, elapsed over the estimate, the phase bar,
/// why the cache missed, the other platform's last build and the latest output line. `wide` adds the phase checklist.
struct BuildInProgressCard: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var build: Build
  var wide: Bool
  var action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      TimelineView(.periodic(from: .now, by: 1)) { context in
        content(now: context.date)
      }
      .padding(Space.lg)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: Radius.card)
          .fill(Palette.primary.opacity(hovering ? 0.09 : 0.05)))
      .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.primary.opacity(0.3)))
      .contentShape(RoundedRectangle(cornerRadius: Radius.card))
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .help("Click for the phase checklist, the build output and recent builds")
  }

  private var target: String? {
    env.devices.first { $0.platform == build.platform && $0.slot == build.slot && !$0.isPhysical }?.label
  }

  private func content(now: Date) -> some View {
    let steps = build.phaseSteps(history: env.builds?.builds(for: build.platform) ?? [], now: now)
    let (phase, counts) = build.currentPhaseLabel
    let elapsed = clockDuration(ms: build.progress(at: now).elapsedMs)
    let estimate = build.expectedMs.map { "~\(clockDuration(ms: $0))" }
    return VStack(alignment: .leading, spacing: Space.md) {
      HStack(spacing: Space.sm) {
        PlatformGlyph(platform: build.platform, size: 13, color: Palette.primary)
        Text("Building \(platformName(build.platform))").font(.stim(.body, weight: .semibold))
        if let target {
          Text(target).font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(1)
        }
        BuildOutcomeBadge(build: build)
        Spacer(minLength: Space.sm)
        Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.tertiary)
      }
      HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
        Text(phase).font(.stim(.footnote, weight: .semibold)).foregroundStyle(Palette.primary)
        if let counts { Text(counts).font(.stim(.footnote)).foregroundStyle(Palette.secondary).lineLimit(1) }
        Spacer(minLength: Space.sm)
        Text(elapsed).font(.stim(.footnote)).monospacedDigit()
          + Text(estimate.map { " / \($0)" } ?? "").font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
      }
      PhaseBar(steps: barSteps(steps))
      if wide {
        PhaseChecklist(steps: steps)
      }
      if let miss = build.missReason?.summary {
        Text("Cache miss: \(miss)").font(.stim(.caption)).foregroundStyle(Palette.secondary)
      }
      if let other = env.otherPlatformLine(building: build.platform, now: now) {
        Text(other).font(.stim(.caption)).foregroundStyle(Palette.tertiary)
      }
      if let line = build.detail?.line {
        Text(line).font(.stim(.caption, mono: true)).foregroundStyle(Palette.tertiary).lineLimit(1).truncationMode(.middle)
      } else {
        BuildOutputTail(cli: cli, workspace: env.path, build: build, limit: 1)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      "Building \(platformName(build.platform)), \(phase)\(counts.map { " \($0)" } ?? ""), \(elapsed)\(estimate.map { " of \($0)" } ?? "")")
  }
}

struct PhaseBar: View {
  var steps: [PhaseStep]

  var body: some View {
    let total = steps.reduce(0) { $0 + ($1.expectedMs ?? 0) }
    let weights = steps.map { total > 0 ? max($0.expectedMs ?? 0, total * 0.18) : 1 }
    VStack(spacing: Space.xs) {
      GeometryReader { geo in
        let sum = weights.reduce(0, +)
        let gaps = CGFloat(max(0, steps.count - 1)) * 3
        HStack(spacing: 3) {
          ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
            let width = (geo.size.width - gaps) * weights[i] / sum
            let fraction = step.state == .current ? (step.fraction ?? 0.1) : (step.fraction ?? 0)
            ZStack(alignment: .leading) {
              Capsule().fill(Palette.primary.opacity(Opacity.tint))
              Capsule().fill(Palette.primary).frame(width: width * fraction)
            }
            .frame(width: width)
          }
        }
      }
      .frame(height: 5)
      GeometryReader { geo in
        let sum = weights.reduce(0, +)
        let gaps = CGFloat(max(0, steps.count - 1)) * 3
        HStack(spacing: 3) {
          ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
            Text(PhaseStep.name(step.phase))
              .font(.stim(.caption2, weight: step.state == .current ? .semibold : nil))
              .foregroundStyle(step.state == .current ? Palette.primary : Palette.tertiary)
              .lineLimit(1)
              .frame(width: (geo.size.width - gaps) * weights[i] / sum, alignment: .leading)
          }
        }
      }
      .frame(height: 13)
    }
    .accessibilityHidden(true)
  }
}

struct PhaseChecklist: View {
  var steps: [PhaseStep]

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      ForEach(steps, id: \.phase) { step in
        HStack(spacing: Space.sm) {
          switch step.state {
          case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.success)
          case .current: ProgressView().controlSize(.mini).frame(width: 12, height: 12)
          case .pending: Image(systemName: "circle").foregroundStyle(Palette.tertiary)
          }
          Text(PhaseStep.name(step.phase))
            .font(.stim(.footnote, weight: step.state == .current ? .semibold : nil))
            .foregroundStyle(step.state == .pending ? Palette.tertiary : Palette.text)
          Spacer(minLength: Space.sm)
          Text(timing(step)).font(.stim(.caption)).foregroundStyle(Palette.tertiary).monospacedDigit()
        }
        .font(.system(size: 11))
      }
    }
  }

  private func timing(_ step: PhaseStep) -> String {
    let expected = step.expectedMs.map { "~\(clockDuration(ms: $0))" }
    switch step.state {
    case .done, .pending: return expected ?? ""
    case .current:
      return [step.elapsedMs.map { clockDuration(ms: $0) }, expected].compactMap { $0 }.joined(separator: " / ")
    }
  }
}

/// Each platform the Build card shows: the running build's phase checklist and output, or the last build and the
/// next build's estimate, then its recent runs.
struct BuildPopover: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var platforms: [String]
  @EnvironmentObject private var checks: BuildPlanChecks

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xl) {
      ForEach(platforms, id: \.self) { platform in section(platform) }
    }
    .font(.stim(.callout))
    .padding(Space.lg)
    .frame(width: 420, alignment: .leading)
  }

  private func section(_ platform: String) -> some View {
    let running = env.build.flatMap { $0.isRunning && $0.platform == platform ? $0 : nil }
    let last = env.lastBuilds?.build(for: platform)
    let history = env.builds?.builds(for: platform) ?? []
    return VStack(alignment: .leading, spacing: Space.md) {
      HStack(spacing: Space.sm) {
        PlatformGlyph(platform: platform, size: 13)
        Text(platformName(platform)).font(.stim(.headline))
        Spacer()
        if running == nil {
          BuildLineRow(
            line: BuildLine.make(
              platform: platform, last: last, plan: checks.entry(workspace: env.path, platform: platform)?.state))
        }
      }
      if let running {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          PhaseChecklist(steps: running.phaseSteps(history: history, now: context.date))
        }
        BuildOutputTail(cli: cli, workspace: env.path, build: running, limit: 8)
          .padding(Space.md)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.sidebar))
      } else if let last {
        Text(last.summary).foregroundStyle(last.status == "ok" ? Palette.secondary : Palette.error)
        if let diagnostics = last.diagnostics, !diagnostics.isEmpty {
          BuildDiagnosticsView(diagnostics: diagnostics, workspace: env.path)
        }
        if let reason = last.missReason {
          MissReasonButton(reason: reason, help: "Why this build missed the cache")
        }
      } else if case .done(.plan(let plan)) = checks.entry(workspace: env.path, platform: platform)?.state {
        Text("Next build: \(plan.nextBuild)").foregroundStyle(Palette.secondary).help(plan.detail ?? "")
      }
      if !history.isEmpty {
        SectionLabel(title: "Recent builds")
        TimelineView(.periodic(from: .now, by: 30)) { context in
          VStack(alignment: .leading, spacing: Space.xxs) {
            ForEach(history.prefix(5), id: \.self) { entry in
              BuildHistoryRow(entry: entry, workspace: env.path, now: context.date)
            }
          }
        }
      }
    }
  }
}

/// The workspace's "..." menu: run, reload, start and stop, logs and worktree removal, with their confirmations.
struct WorkspaceActionsButton: View {
  var env: Workspace
  var openLogs: () -> Void
  @EnvironmentObject private var actions: ActionCenter
  @State private var removal: WorktreeRemoval?
  @State private var confirmingStop = false

  var body: some View {
    let busy = actions.active(for: env.path) != nil
    Menu {
      WorkspaceActionsMenu(
        kind: .workspace(metroRunning: env.metro?.running == true, platforms: env.runPlatforms),
        path: env.path,
        busy: busy,
        removalAllowed: worktreeRemovalAllowed(git: env.worktree?.git),
        building: env.build?.isRunning == true,
        reloadAllowed: env.canReload,
        onShowLastOutput: actions.latest(for: env.path).map { last in { actions.presented = last } },
        onRun: { platform in actions.runApp(env, platform: platform) },
        onReload: { actions.run("Reload \(env.names.title)", StimCommand(["reload"], cwd: env.path)) },
        onStartDevServer: { actions.run("Start \(env.names.title)", StimCommand(["start"], cwd: env.path)) },
        onStopDevServer: {
          if env.remoteDevices?.isEmpty == false {
            confirmingStop = true
          } else {
            stop()
          }
        },
        onShowLogs: openLogs,
        onRemoveWorktree: { resolveRemovalBranch(at: env.path) { removal = WorktreeRemoval(branch: $0) } })
    } label: {
      Image(systemName: "ellipsis")
    }
    .menuStyle(.button)
    .menuIndicator(.hidden)
    .buttonStyle(.borderless)
    .fixedSize()
    .help("Workspace actions")
    .accessibilityLabel("Workspace actions")
    .confirmationDialog("Stop this workspace?", isPresented: $confirmingStop, titleVisibility: .visible) {
      Button("Run stim stop", role: .destructive) { stop() }
    } message: {
      Text("This also ends the workspace's billable EAS Simulator session.")
    }
    .confirmationDialog(
      "Remove this worktree?",
      isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } }),
      titleVisibility: .visible,
      presenting: removal
    ) { _ in
      Button("Run stim worktree remove", role: .destructive) {
        actions.run("Remove \(env.names.title)", StimCommand(["worktree", "remove"], cwd: env.path))
      }
    } message: { removal in
      Text(worktreeRemovalMessage(path: env.path, branch: removal.branch))
    }
  }

  private func stop() {
    actions.run("Stop \(env.names.title)", StimCommand(["stop"], cwd: env.path))
  }
}
