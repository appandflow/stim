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
      if namesPhases(steps) {
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
    case .current: return step.elapsedMs.map { clockDuration(ms: $0) } ?? ""
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
        kind: .workspace(
          metroRunning: env.metro?.running == true, platforms: env.runPlatforms,
          linkedWorktree: env.worktree != nil),
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
