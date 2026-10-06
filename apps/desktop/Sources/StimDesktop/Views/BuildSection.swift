import StimKit
import StimStores
import SwiftUI

/// Each platform the workspace runs: the running build's phase and progress, or the last build and what
/// `stim <platform> --plan` predicts for the next one, with Details, Check and Run. Opening the section checks every
/// platform it shows, unless a build is running. Details opens the build sheet.
struct BuildSection: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var openLogs: (LogQuery) -> Void
  var openBuild: (BuildSheetSelection) -> Void
  var onlyPlatform: String? = nil
  var projectSubtitle: String? = nil
  @EnvironmentObject private var checks: BuildPlanChecks
  @EnvironmentObject private var actions: ActionCenter

  private var running: Build? { env.build.flatMap { $0.isRunning ? $0 : nil } }

  private func buildKey(_ platform: String) -> String { env.lastBuilds?.build(for: platform)?.planKey ?? "" }

  private var platforms: [String] {
    if let onlyPlatform { return onlyPlatform == "macos" ? [] : [onlyPlatform] }
    return env.runPlatforms.filter { $0 == "ios" || $0 == "android" }
  }

  private var cancellationPlatforms: [String] { onlyPlatform == nil ? ["ios", "android"] : platforms }

  private var trigger: [String] {
    [running == nil ? "idle" : "building"] + platforms.map { $0 + "|" + buildKey($0) }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      if onlyPlatform == nil { SectionLabel(title: "Build") }
      if let macos = env.macos, onlyPlatform == nil || onlyPlatform == "macos" {
        HStack {
          Text("macOS \(macos.product)").font(.stim(.callout, weight: .semibold))
          Spacer()
          if onlyPlatform == "macos" {
            Button("Details") { openBuild(BuildSheetSelection(workspace: env.path, platform: "macos")) }
              .buttonStyle(.stim())
              .fixedSize()
              .help("Open build details")
          }
          if let query = LogQuery.build(
            platform: "macos", slot: "default", startedAt: macos.build.startedAt,
            finishedAt: macos.build.finishedAt)
          {
            Button("Build logs") { openLogs(query) }
              .buttonStyle(.stim())
              .fixedSize()
          }
        }
        if let projectSubtitle { Text(projectSubtitle).font(.stim(.footnote)).foregroundStyle(Palette.secondary) }
        Text("Swift Package Debug: \(macos.build.state)").font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        if let error = macos.build.error {
          Text(error).font(.stim(.footnote)).foregroundStyle(Palette.error).textSelection(.enabled)
        }
      }
      ForEach(platforms, id: \.self) { platform in
        card(platform)
      }
    }
    .onAppear(perform: checkUsed)
    .onChange(of: trigger) { checkUsed() }
    .onDisappear { checks.cancel(workspace: env.path, platforms: cancellationPlatforms) }
  }

  private func checkUsed() {
    if running != nil { return checks.cancel(workspace: env.path, platforms: cancellationPlatforms) }
    checks.check(workspace: env.path, builds: Dictionary(uniqueKeysWithValues: platforms.map { ($0, buildKey($0)) }))
  }

  private func card(_ platform: String) -> some View {
    let entry = checks.entry(workspace: env.path, platform: platform)
    let building = running.flatMap { $0.platform == platform ? $0 : nil }
    return Card(
      radius: Radius.control, fill: building == nil ? Palette.surface : Palette.primary.opacity(0.06),
      border: nil, clipsContent: false
    ) {
      VStack(alignment: .leading, spacing: Space.lg) {
        HStack(spacing: Space.sm) {
          PlatformGlyph(platform: platform, size: 12, color: building == nil ? Palette.text : Palette.primary)
          Text(building == nil ? platformName(platform) : "Building \(platformName(platform))")
            .font(.stim(.callout, weight: .semibold))
            .lineLimit(1)
          Spacer()
          Button("Details") { openBuild(BuildSheetSelection(workspace: env.path, platform: platform)) }
            .buttonStyle(.stim())
            .fixedSize()
            .help("Open build details")
          if building == nil { runButton(platform) }
        }
        if let projectSubtitle { Text(projectSubtitle).font(.stim(.footnote)).foregroundStyle(Palette.secondary) }
        if let host = building?.remote(at: Date())?.host {
          Label("on \(host)", systemImage: "desktopcomputer").foregroundStyle(Palette.secondary).lineLimit(1)
        }
        if let building {
          RunningBuildDetail(env: env, build: building)
        } else {
          VStack(alignment: .leading, spacing: Space.sm) {
            Text("Last build").font(.stim(.footnote, weight: .semibold)).foregroundStyle(Palette.secondary)
            lastBuild(platform)
          }
          Divider().overlay(Palette.border)
          VStack(alignment: .leading, spacing: Space.sm) {
            HStack {
              Text("Next build").font(.stim(.footnote, weight: .semibold)).foregroundStyle(Palette.secondary)
              Spacer(minLength: Space.sm)
              checkButton(platform, entry: entry)
            }
            if running != nil {
              Text("Checked after the running build").foregroundStyle(Palette.tertiary)
            } else {
              NextBuildView(entry: entry)
            }
          }
        }
        let history = env.builds?.builds(for: platform) ?? []
        if !history.isEmpty {
          Divider().overlay(Palette.border)
          BuildHistoryList(entries: history) { entry in
            openBuild(
              BuildSheetSelection(
                workspace: env.path, platform: platform, run: "\(platform)|\(entry.slot)|\(entry.build.startedAt)"))
          }
        }
      }
      .padding(Space.lg)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder private func checkButton(_ platform: String, entry: BuildPlanChecks.Entry?) -> some View {
    Button {
      checks.check(workspace: env.path, builds: [platform: buildKey(platform)], force: true)
    } label: {
      Label("Check", systemImage: "magnifyingglass")
    }
    .buttonStyle(.stim())
    .fixedSize()
    .disabled(running != nil || entry?.state == .checking || actions.active(for: env.path) != nil)
    .help("stim \(platform) --plan: predict the next build from the fingerprint and caches, without building")
  }

  @ViewBuilder private func runButton(_ platform: String) -> some View {
    let failed = env.lastBuilds?.build(for: platform)?.status == "failed"
    Button {
      actions.runApp(env, platform: platform)
    } label: {
      Label(failed ? "Rebuild" : "Run", systemImage: "play.fill")
    }
    .buttonStyle(.stim(.primary, .regular))
    .fixedSize()
    .disabled(running != nil || actions.active(for: env.path) != nil)
    .help("stim \(platform) with no options: the default slot and configuration; builds if needed, installs and launches")
  }

  @ViewBuilder private func lastBuild(_ platform: String) -> some View {
    if let last = env.lastBuilds?.build(for: platform) {
      TimelineView(.periodic(from: .now, by: 30)) { context in
        VStack(alignment: .leading, spacing: Space.xs) {
          Text(last.summary)
            .font(.stim(.callout, weight: .semibold))
            .foregroundStyle(last.status == "ok" ? Palette.text : Palette.error)
            .fixedSize(horizontal: false, vertical: true)
            .help(last.fingerprint.map { "Fingerprint \($0)" } ?? "")
          if let endedAt = last.endedAt {
            Text(Format.age(context.date.timeIntervalSince(endedAt)))
              .font(.stim(.footnote))
              .foregroundStyle(Palette.tertiary)
          }
        }
      }
      OffloadFallbackLine(build: last)
      if let diagnostics = last.diagnostics, !diagnostics.isEmpty {
        BuildDiagnosticsView(diagnostics: diagnostics, workspace: env.path)
      }
    } else {
      Text("No build recorded").foregroundStyle(Palette.tertiary)
    }
  }

}

/// The names the app shows for the workspaces at their paths.
struct WorkspaceTitles: Sendable {
  var titles: [String: String] = [:]

  func knows(_ path: String) -> Bool { titles[path] != nil }

  func callAsFunction(_ path: String) -> String { titles[path] ?? (path as NSString).lastPathComponent }
}

private struct WorkspaceTitlesKey: EnvironmentKey {
  static let defaultValue = WorkspaceTitles()
}

extension EnvironmentValues {
  var workspaceTitle: WorkspaceTitles {
    get { self[WorkspaceTitlesKey.self] }
    set { self[WorkspaceTitlesKey.self] = newValue }
  }
}

/// A running build: the phase and its counts, elapsed over the estimate, the phase bar, why the cache missed.
private struct RunningBuildDetail: View {
  var env: Workspace
  var build: Build

  var body: some View {
    TimelineView(.buildSeconds(build)) { context in
      let steps = build.phaseSteps(history: env.builds?.builds(for: build.platform) ?? [], now: context.date)
      let (phase, counts) = build.currentPhaseLabel
      let elapsed = Format.clock(ms: build.progress(at: context.date).elapsedMs)
      let estimate = build.expectedMs.map { "~\(Format.clock(ms: $0))" }
      VStack(alignment: .leading, spacing: Space.md) {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
          Text(phase).font(.stim(.footnote, weight: .semibold)).foregroundStyle(Palette.primary)
          if let counts { Text(counts).font(.stim(.footnote)).foregroundStyle(Palette.secondary).lineLimit(1) }
          Spacer(minLength: Space.sm)
          (Text(elapsed) + Text(estimate.map { " / \($0)" } ?? "").foregroundStyle(Palette.tertiary))
            .font(.stim(.footnote))
            .monospacedDigit()
        }
        PhaseBar(steps: barSteps(steps), key: build.key)
      }
      .accessibilityElement(children: .combine)
    }
    if build.phase == "wait", let holder = build.waitingOn {
      WaitingOnButton(path: holder.path, current: env.path)
    }
    if build.phase == "compile", let line = build.detail?.line {
      Text(line).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    if let miss = build.missReason {
      Text(miss.summary).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        .fixedSize(horizontal: false, vertical: true)
      if let note = build.recheckNote {
        Text(note).font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
      }
    }
  }
}

private struct BuildHistoryList: View {
  var entries: [BuildHistoryEntry]
  var open: (BuildHistoryEntry) -> Void
  @State private var expanded = false

  var body: some View {
    AnimatedDisclosure(isExpanded: expanded) {
      Button {
        expanded.toggle()
      } label: {
        HStack(spacing: Space.sm) {
          Image(systemName: "chevron.right")
            .iconFont(IconSize.small, weight: .semibold)
            .foregroundStyle(Palette.tertiary)
            .rotationEffect(.degrees(expanded ? 90 : 0))
            .frame(width: 12)
          Text("Recent builds (\(entries.count))").foregroundStyle(Palette.secondary)
          Spacer(minLength: 0)
        }
        .padding(.vertical, Space.sm)
        .contentShape(Rectangle())
      }
      .buttonStyle(.hoverRow())
      .accessibilityValue(expanded ? "Expanded" : "Collapsed")
    } content: {
      TimelineView(.periodic(from: .now, by: 30)) { context in
        VStack(alignment: .leading, spacing: Space.xxs) {
          ForEach(entries, id: \.self) { entry in
            BuildHistoryRow(entry: entry, now: context.date) { open(entry) }
          }
        }
        .padding(.top, Space.xs)
      }
    }
  }
}

struct BuildHistoryRow: View {
  var entry: BuildHistoryEntry
  var now: Date
  var open: () -> Void

  private var color: Color {
    switch entry.result {
    case "succeeded": return Palette.success
    case "failed": return Palette.error
    default: return Palette.warning
    }
  }

  var body: some View {
    Button(action: open) {
      VStack(alignment: .leading, spacing: 1) {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
          StatusDot(color: color, size: 6)
          Text(entry.outcome)
            .foregroundStyle(entry.result == "succeeded" ? Palette.secondary : color)
            .lineLimit(1)
          Spacer(minLength: 4)
          Text(entry.build.durationMs.map { Format.elapsed(ms: $0) } ?? "")
            .foregroundStyle(Palette.tertiary)
            .font(.stim(.footnote))
            .monospacedDigit()
            .fixedSize()
          Image(systemName: "chevron.right").foregroundStyle(Palette.tertiary)
        }
        if entry.result == "failed", let code = entry.build.errorCode {
          Text(code).font(.stim(.caption, mono: true)).foregroundStyle(Palette.error)
            .padding(.leading, Space.lg)
        }
        if let endedAt = entry.build.endedAt {
          Text(Format.age(now.timeIntervalSince(endedAt)))
            .font(.stim(.caption)).foregroundStyle(Palette.tertiary).padding(.leading, Space.lg)
        }
      }
    }
    .buttonStyle(.hoverRow(outset: Space.xs))
    .help("Open build details")
  }
}

/// Why a run that considered offloading built here, in a few words; the tooltip holds the whole reason.
struct OffloadFallbackLine: View {
  var build: LastBuild
  var inlineReason = false

  var body: some View {
    if let line = build.fallbackLine {
      VStack(alignment: .leading, spacing: Space.xs) {
        Label(line.text, systemImage: "desktopcomputer")
          .foregroundStyle(Palette.secondary)
          .help(line.reason)
        if inlineReason {
          Text(line.reason).foregroundStyle(Palette.secondary).textSelection(.enabled)
        }
      }
    }
  }
}

struct BuildDiagnosticsView: View {
  var diagnostics: [BuildDiagnostic]
  var workspace: String
  @State private var expanded: Bool

  init(diagnostics: [BuildDiagnostic], workspace: String, initiallyExpanded: Bool = false) {
    self.diagnostics = diagnostics
    self.workspace = workspace
    _expanded = State(initialValue: initiallyExpanded)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      ForEach(Array((expanded ? diagnostics : Array(diagnostics.prefix(1))).enumerated()), id: \.offset) { _, diagnostic in
        Text(diagnostic.text(workspace: workspace))
          .font(.stim(.caption, mono: true))
          .foregroundStyle(Palette.error)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }
      if diagnostics.count > 1 {
        Button(expanded ? "Show fewer" : "Show \(countLabel(diagnostics.count - 1, "more error", plural: "more errors"))") {
          expanded.toggle()
        }
        .buttonStyle(.link)
        .font(.stim(.caption))
      }
    }
  }
}

/// Jumps to the workspace whose build of the same app this run waits for.
struct WaitingOnButton: View {
  var path: String
  var current: String
  var beforeOpen: (() -> Void)? = nil
  @Environment(\.workspaceTitle) private var title

  var body: some View {
    if path == current || !title.knows(path) {
      Text("Waiting for another build of the same app").foregroundStyle(Palette.secondary)
    } else {
      link
    }
  }

  private var link: some View {
    Button {
      beforeOpen?()
      OpenRequests.shared.workspacePath = path
    } label: {
      HStack(spacing: Space.xs) {
        Text("Waiting for \(title(path))'s build of the same app")
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
        Image(systemName: "arrow.right.circle").accessibilityHidden(true)
      }
      .foregroundStyle(Palette.primary)
    }
    .buttonStyle(.hoverRow(outset: Space.xs))
    .help("Open \(title(path))")
  }
}

struct MissReasonButton: View {
  var reason: BuildMissReason
  var help: String
  @State private var shown = false

  var body: some View {
    Button {
      shown.toggle()
    } label: {
      HStack(spacing: Space.xs) {
        Text("Cache miss details")
        Image(systemName: "info.circle")
      }
      .foregroundStyle(Palette.warning)
    }
    .buttonStyle(.hoverRow(outset: Space.xs))
    .accessibilityLabel("Cache miss details: \(reason.summary)")
    .help("\(help)\n\(reason.summary)")
    .popover(isPresented: $shown, arrowEdge: .bottom) {
      MissReasonView(reason: reason)
        .padding(Space.lg)
        .frame(width: 380, alignment: .leading)
    }
  }
}

struct BuildOutcomeBadge: View {
  var build: Build

  var body: some View {
    if let label = build.outcomeLabel {
      Pill(label, tone: build.outcome == "hit" ? .success : .warning, size: .small)
    }
  }
}

struct NextBuildView: View {
  var entry: BuildPlanChecks.Entry?
  var inlineDetails = false

  @ViewBuilder
  private func checkedAt(_ date: Date?) -> some View {
    if let date {
      TimelineView(.periodic(from: .now, by: 30)) { context in
        Text("Checked \(Format.age(context.date.timeIntervalSince(date)))")
          .font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
      }
    }
  }

  @ViewBuilder
  var body: some View {
    switch entry?.state {
    case .checking:
      HStack(spacing: Space.sm) {
        ProgressView().controlSize(.mini)
        Text("Checking next build\u{2026}").foregroundStyle(Palette.tertiary)
      }
    case .done(.plan(let plan)):
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(plan.nextBuild)
          .font(.stim(.callout, weight: .semibold))
          .fixedSize(horizontal: false, vertical: true)
          .foregroundStyle(plan.refusal != nil || plan.cacheHit == .none ? Palette.warning : Palette.success)
          .help(plan.detail ?? "")
        if inlineDetails, let detail = plan.detail {
          Text(detail).foregroundStyle(Palette.secondary).textSelection(.enabled)
        }
        checkedAt(entry?.checkedAt)
        if let reason = plan.missReason {
          if inlineDetails {
            MissReasonView(reason: reason)
          } else {
            MissReasonButton(reason: reason, help: "Why the next build would miss the cache")
          }
        }
        if let refusal = plan.refusal {
          Text([refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " "))
            .foregroundStyle(Palette.secondary)
            .textSelection(.enabled)
        }
      }
    case .done(.refused(let refusal)):
      Text("Cannot plan: \([refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " "))")
        .foregroundStyle(Palette.warning)
        .textSelection(.enabled)
        .help(refusal.code)
    case .failed(let message):
      Text(message).foregroundStyle(Palette.error)
    case nil:
      Text("Not checked yet").foregroundStyle(Palette.tertiary)
    }
  }
}

struct MissReasonView: View {
  var reason: BuildMissReason

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      Text(reason.summary).font(.stim(.body, weight: .semibold)).textSelection(.enabled)
      if let line = reason.baselineLine {
        Text(line).foregroundStyle(Palette.secondary)
      }
      if !reason.changes.isEmpty {
        VStack(alignment: .leading, spacing: Space.xxs) {
          ForEach(reason.changes, id: \.self) { change in
            HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
              Text(change.change == "added" ? "+" : change.change == "removed" ? "\u{2212}" : "~")
                .foregroundStyle(
                  change.change == "added" ? Palette.success : change.change == "removed" ? Palette.error : Palette.warning)
              Text(change.source).font(.stim(.caption, mono: true)).textSelection(.enabled)
            }
          }
        }
      }
      if reason.changeCount > reason.changes.count {
        let hidden = reason.changeCount - reason.changes.count
        Text(hidden == 1 ? "1 more source changed." : "\(hidden) more sources changed.")
          .foregroundStyle(Palette.tertiary)
      }
    }
  }
}
