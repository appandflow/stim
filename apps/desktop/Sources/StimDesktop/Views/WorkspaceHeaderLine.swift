import StimKit
import SwiftUI

/// The top of a workspace page, one line: the stage, the running build's progress, the git chip and the workspace
/// actions. The inspector holds the details.
struct WorkspaceHeaderLine: View {
  var env: Workspace
  var openLogs: () -> Void
  @EnvironmentObject private var actions: ActionCenter

  var body: some View {
    HStack(spacing: Space.md) {
      TimelineView(env.build.flatMap { $0.isRunning ? .buildSeconds($0) : nil } ?? .periodic(from: .now, by: 15)) { context in
        StageLine(env: env, now: context.date)
      }
      Spacer(minLength: Space.md)
      if env.replayOff {
        Pill("Replay off")
          .help("recording.enabled is false for this workspace, so stim-server records none of its screens.")
      }
      if let active = actions.active(for: env.path) {
        ProgressView().controlSize(.small)
        Text(active.title).font(.stim(.footnote)).foregroundStyle(Palette.secondary).lineLimit(1)
        Button("Show output") { actions.presented = active }.buttonStyle(.stim(.plain)).fixedSize()
      }
      WorkspaceActionsButton(env: env, openLogs: openLogs)
    }
  }
}

/// The running build's phase, a short bar and elapsed over the estimate, on the header line.
struct BuildInlineProgress: View {
  var build: Build
  var now: Date

  var body: some View {
    let progress = build.progress(at: now)
    let (phase, counts) = build.currentPhaseLabel
    let elapsed = clockDuration(ms: progress.elapsedMs)
    let estimate = build.expectedMs.map { "~\(clockDuration(ms: $0))" }
    let time = ZStack(alignment: .leading) {
      Text("00:00 / ~00:00").hidden()
      Text(elapsed) + Text(estimate.map { " / \($0)" } ?? "").foregroundStyle(Palette.tertiary)
    }
    .font(.stim(.footnote))
    .monospacedDigit()
    .lineLimit(1)
    .fixedSize()
    let host = build.remote(at: now)?.host
    ViewThatFits(in: .horizontal) {
      HStack(spacing: Space.sm) {
        ZStack(alignment: .trailing) {
          Text("Copying resources").hidden()
          Text(phase).foregroundStyle(Palette.primary)
        }
        .font(.stim(.footnote, weight: .semibold))
        .fixedSize()
        if host != nil {
          Image(systemName: "desktopcomputer").font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        }
        bar(progress).frame(width: 96)
        time
      }
      HStack(spacing: Space.sm) {
        bar(progress).frame(width: 56)
        time
      }
      time
    }
    .help([phase, counts, host.map { "on \($0)" }].compactMap { $0 }.joined(separator: " \u{00B7} "))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      "\(phase)\(counts.map { " \($0)" } ?? "")\(host.map { " on \($0)" } ?? ""), \(elapsed)\(estimate.map { " of \($0)" } ?? "")"
    )
  }

  private func bar(_ progress: BuildProgress) -> some View {
    Group {
      if let fraction = progress.fraction {
        ProgressView(value: fraction)
      } else {
        ProgressView().progressViewStyle(.linear)
      }
    }
    .tint(Palette.primary)
    .controlSize(.small)
  }
}

func formatMemoryMb(_ mb: Double) -> String {
  mb >= 1024 ? String(format: "%.1f GB", mb / 1024) : "\(Int(mb.rounded())) MB"
}

extension WorkspaceStage.Tone {
  var color: Color {
    switch self {
    case .success: return Palette.success
    case .brand: return Palette.primary
    case .error: return Palette.error
    case .warning: return Palette.warning
    case .tertiary: return Palette.tertiary
    }
  }
}

struct StageLine: View {
  var env: Workspace
  var now: Date

  var body: some View {
    let stage = env.stage(now: now)
    HStack(spacing: Space.md) {
      HStack(spacing: Space.sm) {
        StatusDot(color: stage.tone.color)
        Text(stage.label.rawValue).font(.stim(.callout, weight: .semibold)).fixedSize()
        if let subtitle = stage.subtitle {
          Text(subtitle).font(.stim(.callout)).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.tail)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel([stage.label.rawValue, stage.subtitle].compactMap { $0 }.joined(separator: ", "))
      .layoutPriority(-1)
      if let build = env.build, build.isRunning {
        BuildInlineProgress(build: build, now: now)
      }
      if let chip = GitChip(env.worktree) {
        Rectangle().fill(Palette.border).frame(width: 1, height: 14)
        GitChipButton(chip: chip, worktree: env.worktree!).layoutPriority(1)
      }
    }
  }
}

extension GitChip.Tone {
  var color: Color {
    switch self {
    case .normal: return Palette.text
    case .secondary: return Palette.secondary
    case .tertiary: return Palette.tertiary
    case .success: return Palette.success
    case .warning: return Palette.warning
    case .error: return Palette.error
    case .brand: return Palette.primary
    }
  }
}

struct ChecksMark: View {
  var checks: GitChip.Checks

  var body: some View {
    switch checks {
    case .passing: Image(systemName: "checkmark").foregroundStyle(Palette.success)
    case .failing: Image(systemName: "xmark").foregroundStyle(Palette.error)
    case .pending: Circle().fill(Palette.warning).frame(width: 6, height: 6)
    }
  }
}

struct GitChipButton: View {
  var chip: GitChip
  var worktree: WorktreeInfo
  @State private var shown = false
  @State private var hovering = false

  var body: some View {
    Button {
      shown = true
    } label: {
      HStack(spacing: Space.xs + 1) {
        if let pull = chip.pullRequest {
          Text(pull.text).font(.stim(.caption, weight: .semibold)).foregroundStyle(pull.tone.color)
          if let checks = pull.checks { ChecksMark(checks: checks).font(.system(size: 9, weight: .bold)) }
        } else {
          Image(systemName: "arrow.triangle.branch").foregroundStyle(Palette.secondary)
        }
        ForEach(chip.parts, id: \.text) { part in
          Text(part.text).foregroundStyle(part.tone.color).monospacedDigit()
        }
        Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold)).foregroundStyle(Palette.tertiary)
      }
      .font(.stim(.caption))
      .padding(.horizontal, Space.md)
      .padding(.vertical, 3)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(hovering ? Palette.raised : Palette.surface))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .help("\(chip.label). Click for the branch and pull request.")
    .accessibilityLabel(chip.label)
    .popover(isPresented: $shown, arrowEdge: .bottom) {
      GitPopover(worktree: worktree).presentationBackground(Palette.surface)
    }
  }
}

struct GitPopover: View {
  var worktree: WorktreeInfo

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack(spacing: Space.sm) {
        Image(systemName: "arrow.triangle.branch").foregroundStyle(Palette.secondary)
        Text(worktree.branch ?? "Detached HEAD").font(.stim(.body, weight: .semibold)).textSelection(.enabled)
      }
      if let git = worktree.git {
        Text(git.upstream.map { "Tracks \($0)" } ?? "No upstream").foregroundStyle(Palette.secondary)
        Text(git.summary == "Clean" ? "No uncommitted or unpushed changes" : git.summary).foregroundStyle(Palette.secondary)
      }
      if let pull = worktree.pullRequest {
        Rectangle().fill(Palette.border).frame(height: 1)
        HStack(spacing: Space.sm) {
          Text("PR #\(pull.number)").font(.stim(.callout, weight: .semibold))
            .foregroundStyle(GitChip.tone(ofPullRequest: pull.state).color)
          Pill(pull.state.capitalized, size: .small)
        }
        Text(pull.title).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        if let checks = GitChip.checks(pull.checks) {
          HStack(spacing: Space.sm) {
            ChecksMark(checks: checks).font(.system(size: 10, weight: .bold))
            Text("Checks: \(GitChip.checksSummary(pull.checks) ?? "none")").foregroundStyle(Palette.secondary)
          }
        }
        if let review = pull.reviewDecision {
          Text("Review: \(review.replacingOccurrences(of: "-", with: " "))").foregroundStyle(Palette.secondary)
        }
        if let url = URL(string: pull.url) {
          Button("Open on GitHub", systemImage: "arrow.up.right.square") { NSWorkspace.shared.open(url) }
            .buttonStyle(.stim())
            .help(pull.url)
        }
      }
    }
    .font(.stim(.callout))
    .padding(Space.lg)
    .frame(width: 320, alignment: .leading)
  }
}

/// CPU, memory and disk with their icons.
struct UsageFigures: View {
  var usage: WorkspaceUsage

  var body: some View {
    if let cpu = usage.cpuPercent { figure("cpu", formatPercent(cpu), help: "CPU, where 100% is one core") }
    if let memory = usage.memoryMb { figure("memorychip", formatMemoryMb(memory), help: "Memory, as Activity Monitor counts it") }
    if let disk = usage.diskBytes {
      figure("internaldrive", formatDisk(Int64(disk)), help: "Disk: the worktree and Stim's build folder", minor: true)
    }
  }

  private func figure(_ icon: String, _ value: String, help: String, minor: Bool = false) -> some View {
    HStack(spacing: Space.xs + 1) {
      Image(systemName: icon).font(.system(size: 10)).foregroundStyle(Palette.secondary).frame(width: 14)
      Text(value)
        .font(.stim(.footnote))
        .foregroundStyle(minor ? Palette.secondary : Palette.text)
        .monospacedDigit()
        .lineLimit(1)
    }
    .help(help)
  }
}

struct ProcessRowsTable: View {
  var rows: [ProcessRow]

  var body: some View {
    Grid(alignment: .leading, horizontalSpacing: Space.md, verticalSpacing: Space.sm) {
      GridRow {
        Text("Process")
        Text("CPU").gridColumnAlignment(.trailing)
        Text("Memory").gridColumnAlignment(.trailing)
      }
      .font(.stim(.caption, weight: .semibold))
      .foregroundStyle(Palette.tertiary)
      ForEach(rows) { row in
        GridRow {
          Text(row.label).lineLimit(1).truncationMode(.middle)
          Text(formatPercent(row.cpuPercent)).monospacedDigit().gridColumnAlignment(.trailing)
          Text(formatMemoryMb(row.memoryMb)).monospacedDigit().gridColumnAlignment(.trailing)
        }
        .font(.stim(.callout))
      }
    }
  }
}

/// The Apple logo or the Android head in the same square box, so rows line up whatever the platform.
struct PlatformGlyph: View {
  var platform: String
  var size: CGFloat = 12
  var color: Color = Palette.text

  var body: some View {
    Group {
      if platform == "ios" {
        Image(systemName: "apple.logo").font(.system(size: size * 0.95, weight: .medium)).foregroundStyle(color)
      } else {
        AndroidHead().fill(color, style: FillStyle(eoFill: true)).frame(width: size * 1.1, height: size * 0.93)
      }
    }
    .frame(width: size + 3, height: size + 3)
    .accessibilityLabel(platformName(platform))
  }
}

private struct AndroidHead: Shape {
  func path(in rect: CGRect) -> Path {
    let sx = rect.width / 26
    let sy = rect.height / 22
    var path = Path()
    path.addArc(
      center: CGPoint(x: 13 * sx, y: 21 * sy), radius: 11 * sx, startAngle: .degrees(180), endAngle: .degrees(0),
      clockwise: false)
    path.closeSubpath()
    for (from, to) in [(CGPoint(x: 6.5, y: 5.5), CGPoint(x: 4, y: 1.5)), (CGPoint(x: 19.5, y: 5.5), CGPoint(x: 22, y: 1.5))] {
      var line = Path()
      line.move(to: CGPoint(x: from.x * sx, y: from.y * sy))
      line.addLine(to: CGPoint(x: to.x * sx, y: to.y * sy))
      path.addPath(line.strokedPath(StrokeStyle(lineWidth: 1.8 * sx, lineCap: .round)))
    }
    for x in [8.5, 17.5] {
      path.addEllipse(in: CGRect(x: (x - 1.4) * sx, y: (14.5 - 1.4) * sy, width: 2.8 * sx, height: 2.8 * sy))
    }
    return path
  }
}
