import StimKit
import SwiftUI

/// The top of a workspace page: the stage line with the git chip and the workspace actions, then the Resources,
/// Build and Logs cards, or the build-in-progress card while a build runs. `wide` shows each card's detail inline.
struct WorkspaceSummary: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var machine: MachineUsage?
  var reportsBundles: Bool
  var history: OwnerHistory
  var usage: UsageHistory?
  var wide: Bool
  var openLogs: (_ errors: Bool) -> Void
  @EnvironmentObject private var checks: BuildPlanChecks
  @EnvironmentObject private var actions: ActionCenter
  @State private var showsResources = false
  @State private var showsBuild = false
  @State private var showsBuilding = false

  private var running: Build? { env.build.flatMap { $0.isRunning ? $0 : nil } }

  var body: some View {
    TimelineView(.periodic(from: .now, by: 15)) { context in
      VStack(alignment: .leading, spacing: Space.lg) {
        HStack(spacing: Space.md) {
          StageLine(env: env, now: context.date)
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
          WorkspaceActionsButton(env: env, openLogs: { openLogs(false) })
        }
        HStack(alignment: .top, spacing: Space.md) {
          resourcesCard
          if running == nil { buildCard }
          logsCard(now: context.date)
        }
        .fixedSize(horizontal: false, vertical: true)
        if let running {
          BuildInProgressCard(cli: cli, env: env, build: running, wide: wide) { showsBuilding = true }
            .popover(isPresented: $showsBuilding, arrowEdge: .bottom) {
              BuildPopover(cli: cli, env: env, platforms: env.buildCardPlatforms)
            }
        }
      }
    }
    .onAppear(perform: checkPlans)
    .onChange(of: planTrigger) { checkPlans() }
    .onChange(of: running == nil) {
      showsBuild = false
      showsBuilding = false
    }
  }

  private var planTrigger: [String] {
    [env.path, running == nil ? "idle" : "building"]
      + env.buildCardPlatforms.map { "\(buildKey($0))|\(checks.entry(workspace: env.path, platform: $0) == nil)" }
  }

  private func buildKey(_ platform: String) -> String { env.lastBuilds?.build(for: platform)?.planKey ?? "" }

  private func checkPlans() {
    guard running == nil else { return }
    let unbuilt = env.buildCardPlatforms.filter { env.lastBuilds?.build(for: $0) == nil }
    checks.check(workspace: env.path, builds: Dictionary(uniqueKeysWithValues: unbuilt.map { ($0, buildKey($0)) }))
  }

  private var resolvedUsage: WorkspaceUsage {
    var usage = env.usage(machine: machine)
    if usage.cpuPercent == nil, let sampled = self.usage {
      usage.cpuPercent = sampled.latest.cpuPercent
      if sampled.memoryBytes > 0 { usage.memoryMb = Double(sampled.memoryBytes) / 1_048_576 }
    }
    return usage
  }

  private var resourcesCard: some View {
    let usage = resolvedUsage
    let rows = env.processRows(machine: machine)
    return SummaryCard(
      title: "Resources", help: "CPU, memory and disk of this workspace. Click for every process.",
      spoken: "Resources: \(usageLabel(usage) ?? "not measured")"
    ) {
      showsResources = true
    } content: {
      if usage.isEmpty {
        Text("Not measured").font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
      }
      UsageFigures(usage: usage, large: true)
      if wide, !rows.isEmpty {
        Rectangle().fill(Palette.border).frame(height: 1).padding(.vertical, Space.xxs)
        ProcessRowsTable(rows: Array(rows.prefix(4)), compact: true)
      }
    }
    .popover(isPresented: $showsResources, arrowEdge: .bottom) {
      ResourcesPopover(env: env, usage: usage, rows: rows, history: history, sampled: self.usage)
    }
  }

  private var buildCard: some View {
    let lines = env.buildCardPlatforms.map { platform in
      BuildLine.make(
        platform: platform, last: env.lastBuilds?.build(for: platform),
        plan: checks.entry(workspace: env.path, platform: platform)?.state)
    }
    let failed = lines.contains { $0.tone == .error }
    return SummaryCard(
      title: "Build", alert: failed, help: "Each platform's last build, or what the next one would take. Click for details.",
      spoken: "Build: " + lines.map(\.spoken).joined(separator: ", ")
    ) {
      showsBuild = true
    } content: {
      ForEach(lines, id: \.platform) { line in BuildLineRow(line: line) }
    }
    .popover(isPresented: $showsBuild, arrowEdge: .bottom) {
      BuildPopover(cli: cli, env: env, platforms: env.buildCardPlatforms)
    }
  }

  private func logsCard(now: Date) -> some View {
    let errors = env.logs?.errorsSinceMarker
    let health = env.metroHealth
    let bundle = env.bundleLine(now: now, reportsBundles: reportsBundles)
    let spoken = [
      "Logs", errors.map { countLabel($0, "error") }, env.metro.map { "Metro port \($0.port), \(health?.rawValue ?? "")" },
      bundle?.text,
    ].compactMap { $0 }.joined(separator: ", ")
    return SummaryCard(
      title: "Logs", alert: (errors ?? 0) > 0,
      help: (errors ?? 0) > 0 ? "Open the logs filtered to errors" : "Open the logs", spoken: spoken
    ) {
      openLogs((errors ?? 0) > 0)
    } content: {
      if errors == nil, env.metro == nil, bundle == nil {
        Text("No logs yet").font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
      }
      if let errors {
        HStack(spacing: Space.sm) {
          StatusDot(color: errors > 0 ? Palette.error : Palette.border)
          Text("\(errors)").font(.stim(.callout, weight: .semibold)).monospacedDigit()
          Text(errors == 1 ? "error" : "errors").font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        }
      }
      if let metro = env.metro, let health {
        HStack(spacing: Space.sm) {
          StatusDot(
            color: health == .healthy ? Palette.success : health == .unhealthy ? Palette.error : Palette.tertiary,
            filled: health != .stopped)
          Text("Metro").font(.stim(.footnote, weight: .semibold))
          Text(":\(String(metro.port))").font(.stim(.footnote)).foregroundStyle(Palette.secondary).monospacedDigit()
        }
        .help(
          env.supervisor.map { "\($0.mode ?? "supervisor") \u{00B7} \(health.rawValue)" } ?? "Metro \(health.rawValue)")
      }
      if let bundle {
        Text(bundle.text)
          .font(.stim(.caption))
          .foregroundStyle(bundle.tone == .error ? Palette.error : bundle.tone == .tertiary ? Palette.tertiary : Palette.secondary)
          .lineLimit(2)
      }
    }
  }

  private func usageLabel(_ usage: WorkspaceUsage) -> String? {
    let parts = [
      usage.cpuPercent.map { "CPU \(formatPercent($0))" }, usage.memoryMb.map { "memory \(formatMemoryMb($0))" },
      usage.diskBytes.map { "disk \(formatDisk(Int64($0)))" },
    ].compactMap { $0 }
    return parts.isEmpty ? nil : parts.joined(separator: ", ")
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
        Text(stage.label.rawValue).font(.stim(.callout, weight: .semibold))
        if let subtitle = stage.subtitle {
          Text(subtitle).font(.stim(.callout)).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.tail)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel([stage.label.rawValue, stage.subtitle].compactMap { $0 }.joined(separator: ", "))
      if let chip = GitChip(env.worktree) {
        Rectangle().fill(Palette.border).frame(width: 1, height: 14)
        GitChipButton(chip: chip, worktree: env.worktree!)
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
    .popover(isPresented: $shown, arrowEdge: .bottom) { GitPopover(worktree: worktree) }
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

/// A summary card: an uppercase title with a chevron, its content, and a raised fill on hover. `alert` tints it red.
struct SummaryCard<Content: View>: View {
  var title: String
  var alert = false
  var help: String
  var spoken: String
  var action: () -> Void
  @ViewBuilder var content: Content
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: Space.xs) {
        HStack {
          SectionLabel(title: title)
          Spacer(minLength: Space.xs)
          Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.tertiary)
        }
        content
        Spacer(minLength: 0)
      }
      .padding(Space.md + Space.xxs)
      .frame(maxWidth: .infinity, minHeight: 88, maxHeight: .infinity, alignment: .topLeading)
      .background(
        RoundedRectangle(cornerRadius: Radius.card)
          .fill(alert ? Palette.error.opacity(0.06) : hovering ? Palette.raised : Palette.surface))
      .overlay(
        RoundedRectangle(cornerRadius: Radius.card).strokeBorder(alert ? Palette.error.opacity(0.45) : Palette.border))
      .contentShape(RoundedRectangle(cornerRadius: Radius.card))
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .help(help)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(spoken)
    .accessibilityAddTraits(.isButton)
  }
}

/// CPU, memory and disk with their icons.
struct UsageFigures: View {
  var usage: WorkspaceUsage
  var large = false

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
        .font(.stim(large && !minor ? .callout : .footnote, weight: large && !minor ? .semibold : nil))
        .foregroundStyle(minor ? Palette.secondary : Palette.text)
        .monospacedDigit()
        .lineLimit(1)
    }
    .help(help)
  }
}

struct ProcessRowsTable: View {
  var rows: [ProcessRow]
  var compact = false

  var body: some View {
    Grid(alignment: .leading, horizontalSpacing: Space.md, verticalSpacing: compact ? Space.xxs : Space.sm) {
      if !compact {
        GridRow {
          Text("Process")
          Text("CPU").gridColumnAlignment(.trailing)
          Text("Memory").gridColumnAlignment(.trailing)
        }
        .font(.stim(.caption, weight: .semibold))
        .foregroundStyle(Palette.tertiary)
      }
      ForEach(rows) { row in
        GridRow {
          Text(row.label).lineLimit(1).truncationMode(.middle)
          Text(formatPercent(row.cpuPercent)).monospacedDigit().gridColumnAlignment(.trailing)
          Text(formatMemoryMb(row.memoryMb)).monospacedDigit().gridColumnAlignment(.trailing)
        }
        .font(.stim(compact ? .caption : .callout))
        .foregroundStyle(compact ? Palette.secondary : Palette.text)
      }
    }
  }
}

struct ResourcesPopover: View {
  var env: Workspace
  var usage: WorkspaceUsage
  var rows: [ProcessRow]
  var history: OwnerHistory
  var sampled: UsageHistory?

  var body: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("Resources").font(.stim(.headline))
      HStack(alignment: .top, spacing: Space.md) {
        chart(
          "cpu", "CPU", usage.cpuPercent.map(formatPercent) ?? "\u{2014}",
          values: history.cpu(env.path).isEmpty ? sampled?.cpu ?? [] : history.cpu(env.path), minimumPeak: 100)
        chart(
          "memorychip", "Memory", usage.memoryMb.map(formatMemoryMb) ?? "\u{2014}",
          values: history.memoryMb(env.path).isEmpty
            ? sampled.map { $0.memory.map { $0 / 1_048_576 } } ?? [] : history.memoryMb(env.path),
          minimumPeak: 1024)
      }
      if let window = window {
        Text(window).font(.stim(.caption)).foregroundStyle(Palette.tertiary)
      }
      if rows.isEmpty {
        Text("stim status reports no processes for this workspace.").foregroundStyle(Palette.tertiary)
      } else {
        ProcessRowsTable(rows: rows)
      }
      if let disk = env.diskBreakdown(format: { formatDisk(Int64($0)) }) {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
          Image(systemName: "internaldrive").foregroundStyle(Palette.secondary)
          Text(disk).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .font(.stim(.callout))
    .padding(Space.lg)
    .frame(width: 380, alignment: .leading)
  }

  private var window: String? {
    guard let span = history.span(env.path), span >= 60 else { return nil }
    return "Last \(shortDuration(span)), sampled while Stim Desktop is on screen"
  }

  private func chart(_ icon: String, _ title: String, _ value: String, values: [Double], minimumPeak: Double)
    -> some View
  {
    VStack(alignment: .leading, spacing: Space.xs) {
      Label(title, systemImage: icon).foregroundStyle(Palette.secondary)
      Text(value).font(.stim(.title)).monospacedDigit()
      Sparkline(values: values, minimumPeak: minimumPeak).frame(height: 32)
    }
    .padding(Space.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
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

struct BuildLineRow: View {
  var line: BuildLine

  var body: some View {
    HStack(spacing: Space.xs + 1) {
      PlatformGlyph(platform: line.platform, color: line.isEstimate ? Palette.secondary : Palette.text)
      if line.isEstimate {
        Text(line.main).font(.stim(.footnote)).foregroundStyle(Palette.secondary).monospacedDigit()
        if let sub = line.sub { Text(sub).font(.stim(.caption2)).foregroundStyle(Palette.tertiary) }
      } else {
        Text(line.main)
          .font(.stim(.footnote, weight: line.tone == .normal ? .semibold : nil))
          .foregroundStyle(line.tone == .error ? Palette.error : line.tone == .secondary ? Palette.secondary : Palette.text)
          .monospacedDigit()
        if let sub = line.sub {
          Text(sub).font(.stim(.caption2)).foregroundStyle(Palette.tertiary)
        }
      }
    }
    .lineLimit(1)
    .help(
      line.isEstimate
        ? "\(line.spoken), estimated by stim \(line.platform) --plan"
        : line.spoken)
  }
}
