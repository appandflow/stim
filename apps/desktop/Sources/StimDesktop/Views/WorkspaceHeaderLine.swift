import StimKit
import StimStores
import SwiftUI

/// The top of a workspace page, one line: the stage, the running build's progress, the git chip and the workspace
/// actions. The inspector holds the details.
struct WorkspaceHeaderLine: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var page: WorktreePage? = nil
  var openAppLogs: ((Workspace) -> Void)? = nil
  var openLogs: () -> Void
  var openBuild: (BuildSheetSelection) -> Void
  @EnvironmentObject private var actions: ActionCenter

  var body: some View {
    let apps = page?.apps ?? [env]
    let active = page.flatMap { actions.active(for: $0.actionKey) } ?? apps.compactMap { actions.active(for: $0.path) }.first
    let buildingApp = apps.first { $0.build?.isRunning == true }
    let running = buildingApp?.build
    HStack(spacing: Space.md) {
      TimelineView(
        (page == nil ? env.build : running).flatMap { $0.isRunning ? .buildSeconds($0) : nil } ?? .periodic(from: .now, by: 15)
      ) { context in
        let lead = page?.lead(now: context.date) ?? env
        StageLine(
          cli: cli, env: lead, now: context.date,
          inlineBuild: page == nil ? nil : (lead.build?.isRunning == true ? lead.build : running),
          inlineWorkspace: page == nil ? nil : (lead.build?.isRunning == true ? lead.path : buildingApp?.path),
          gitWorkspace: page?.apps[0].path,
          openBuild: openBuild)
      }
      Spacer(minLength: Space.md)
      if apps.contains(where: \.replayOff) {
        Pill("Replay off")
          .help("recording.enabled is false for this workspace, so stim-server records none of its screens.")
      }
      if let active {
        ProgressView().controlSize(.small)
        Text(active.title).font(.stim(.footnote)).foregroundStyle(Palette.secondary).lineLimit(1)
        Button("Show output") { actions.presented = active }.buttonStyle(.stim(.plain)).fixedSize()
      }
      if let page {
        WorktreeActionsButton(page: page, openLogs: { app in openAppLogs?(app) })
      } else {
        WorkspaceActionsButton(env: env, openLogs: openLogs)
      }
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
    let elapsed = Format.clock(ms: progress.elapsedMs)
    let estimate = build.expectedMs.map { "~\(Format.clock(ms: $0))" }
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

struct StageLine: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var now: Date
  var inlineBuild: Build? = nil
  var inlineWorkspace: String? = nil
  var gitWorkspace: String? = nil
  var openBuild: (BuildSheetSelection) -> Void

  var body: some View {
    let stage = env.stage(now: now)
    HStack(spacing: Space.md) {
      HStack(spacing: Space.sm) {
        StatusDot(color: Color(stage.tone))
        Text(stage.label.rawValue).font(.stim(.callout, weight: .semibold)).fixedSize()
        if let subtitle = stage.subtitle {
          Text(subtitle).font(.stim(.callout)).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.tail)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel([stage.label.rawValue, stage.subtitle].compactMap { $0 }.joined(separator: ", "))
      .layoutPriority(-1)
      if let build = inlineBuild ?? env.build, build.isRunning {
        Button {
          openBuild(BuildSheetSelection(workspace: inlineWorkspace ?? env.path, platform: build.platform, run: build.key))
        } label: {
          BuildInlineProgress(build: build, now: now)
        }
        .buttonStyle(.hoverRow())
        .help("Open build details")
        .accessibilityHint("Opens the running build's details")
      }
      if let chip = GitChip(env.worktree) {
        Rectangle().fill(Palette.border).frame(width: 1, height: 14)
        GitChipButton(cli: cli, chip: chip, worktree: env.worktree!, workspace: gitWorkspace ?? env.path).layoutPriority(1)
      }
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
  var cli: Task<StimCLI, Never>
  var chip: GitChip
  var worktree: WorktreeInfo
  var workspace: String
  @State private var shown = false
  @State private var reviewing = false
  @State private var openError: String?
  @AppStorage(AppPreferences.Key.diffViewer) private var diffViewer = DiffViewer.builtIn

  var body: some View {
    Button {
      shown = true
    } label: {
      Card(radius: Radius.control, border: nil, clipsContent: false) {
        HStack(spacing: Space.xs + 1) {
          if let pull = chip.pullRequest {
            Text(pull.text).font(.stim(.caption, weight: .semibold)).foregroundStyle(Color(pull.tone))
            if let checks = pull.checks { ChecksMark(checks: checks).iconFont(IconSize.indicator, weight: .bold) }
          } else {
            Image(systemName: "arrow.triangle.branch").foregroundStyle(Palette.secondary)
          }
          ForEach(chip.parts, id: \.text) { part in
            Text(part.text).foregroundStyle(Color(part.tone)).monospacedDigit()
          }
          Image(systemName: "chevron.down").iconFont(IconSize.micro, weight: .semibold).foregroundStyle(Palette.tertiary)
        }
        .font(.stim(.caption))
        .lineLimit(1)
        .padding(.horizontal, Space.md)
        .padding(.vertical, 3)
      }
    }
    .buttonStyle(.hoverRow(radius: Radius.control))
    .help("\(chip.label). Click for the branch and pull request.")
    .accessibilityLabel(chip.label)
    .popover(isPresented: $shown, arrowEdge: .bottom) {
      GitPopover(worktree: worktree, reviewChanges: reviewChanges).presentationBackground(Palette.surface)
    }
    .sheet(isPresented: $reviewing) { WorkspaceDiffView(cli: cli, workspace: workspace) }
    .alert("Could not open changes", isPresented: Binding(get: { openError != nil }, set: { if !$0 { openError = nil } })) {
      Button("OK") { openError = nil }
    } message: {
      Text(openError ?? "")
    }
  }

  private func reviewChanges() {
    shown = false
    if diffViewer == .builtIn {
      reviewing = true
      return
    }
    guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.VSCode") else {
      openError = "Visual Studio Code is not installed. Choose Built-in in Settings > Integrations."
      return
    }
    NSWorkspace.shared.open(
      [URL(fileURLWithPath: worktree.path).resolvingSymlinksInPath()], withApplicationAt: app,
      configuration: NSWorkspace.OpenConfiguration()
    ) { _, error in
      if let error { Task { @MainActor in openError = error.localizedDescription } }
    }
  }
}

struct GitPopover: View {
  var worktree: WorktreeInfo
  var reviewChanges: () -> Void

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
      Button("Review changes", systemImage: "doc.text.magnifyingglass", action: reviewChanges)
        .buttonStyle(.stim())
      if let pull = worktree.pullRequest {
        Rectangle().fill(Palette.border).frame(height: 1)
        HStack(spacing: Space.sm) {
          Text("PR #\(pull.number)").font(.stim(.callout, weight: .semibold))
            .foregroundStyle(Color(GitChip.tone(ofPullRequest: pull.state)))
          Pill(pull.state.capitalized, size: .small)
        }
        Text(pull.title).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        if let checks = GitChip.checks(pull.checks) {
          HStack(spacing: Space.sm) {
            ChecksMark(checks: checks).iconFont(IconSize.compact, weight: .bold)
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
    if let memory = usage.memoryMb {
      figure("memorychip", Format.memoryMb(memory), help: "Memory, as Activity Monitor counts it")
    }
    if let disk = usage.diskBytes {
      figure("internaldrive", Format.fileSize(Int64(disk)), help: "Disk: the worktree and Stim's build folder", minor: true)
    }
  }

  private func figure(_ icon: String, _ value: String, help: String, minor: Bool = false) -> some View {
    HStack(spacing: Space.xs + 1) {
      Image(systemName: icon).iconFont(IconSize.compact).foregroundStyle(Palette.secondary).frame(width: 14)
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
          Text(Format.memoryMb(row.memoryMb)).monospacedDigit().gridColumnAlignment(.trailing)
        }
        .font(.stim(.callout))
      }
    }
  }
}

struct PlatformGlyph: View {
  var platform: String
  var size: CGFloat = 12
  var color: Color = Palette.text

  var body: some View {
    Group {
      if platform == "ios" {
        Image(systemName: "apple.logo").font(.system(size: size * 0.95, weight: .medium)).foregroundStyle(color)
          .offset(y: -1)
      } else if platform == "macos" || platform == "web" {
        Image(systemName: platform == "macos" ? "laptopcomputer" : "globe")
          .iconFont(size, weight: .medium).foregroundStyle(color)
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
