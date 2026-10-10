import StimKit
import StimStores
import SwiftUI

struct BuildSection: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var openLogs: (LogQuery) -> Void
  var openBuild: (BuildSheetSelection) -> Void
  var readOnly = false
  var totals: String? = nil
  var onlyPlatform: String? = nil
  var projectSubtitle: String? = nil
  #if DEBUG
    @Environment(\.fixtureDate) private var fixtureDate
  #else
    private var fixtureDate: Date? { nil }
  #endif
  @EnvironmentObject private var checks: BuildPlanChecks
  @EnvironmentObject private var actions: ActionCenter

  private var running: Build? { env.build.flatMap { $0.isRunning ? $0 : nil } }

  private func lastBuildRecord(_ platform: String) -> LastBuild? {
    env.lastBuilds?.build(for: platform) ?? env.builds?.builds(for: platform).first?.build
  }
  private func buildKey(_ platform: String) -> String { lastBuildRecord(platform)?.planKey ?? "" }
  private func finishedAt(_ platform: String) -> Date? {
    lastBuildRecord(platform).flatMap { $0.finishedAt == nil ? nil : $0.endedAt }
  }

  private var platforms: [String] {
    if let onlyPlatform { return [onlyPlatform] }
    return env.runPlatforms.filter { ["ios", "android", "macos"].contains($0) }
  }

  private var cancellationPlatforms: [String] { platforms }

  private var trigger: [String] {
    [running == nil ? "idle" : "building"] + platforms.map { $0 + "|" + buildKey($0) }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      if onlyPlatform == nil { SectionLabel(title: "Build") }
      if readOnly && platforms.isEmpty {
        InlineEmpty("No build recorded")
        if let totals { Text(totals).font(.stim(.footnote)).foregroundStyle(Palette.secondary) }
      }
      ForEach(platforms, id: \.self) { platform in
        card(platform)
      }
    }
    .task(id: trigger) {
      guard !readOnly else { return }
      while !Task.isCancelled {
        checkUsed()
        try? await Task.sleep(for: .seconds(30))
      }
    }
  }

  private func checkUsed() {
    guard !readOnly else { return }
    if running != nil || actions.active(for: env.path) != nil {
      return checks.cancel(workspace: env.path, platforms: cancellationPlatforms)
    }
    checks.check(
      workspace: env.path, builds: Dictionary(uniqueKeysWithValues: platforms.map { ($0, buildKey($0)) }),
      finishedAt: Dictionary(
        uniqueKeysWithValues: platforms.compactMap { platform in
          finishedAt(platform).map { (platform, $0) }
        }))
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
          if building == nil && !readOnly { runButton(platform) }
        }
        if let projectSubtitle { Text(projectSubtitle).font(.stim(.footnote)).foregroundStyle(Palette.secondary) }
        if let host = building?.remote(at: Date())?.host {
          Label(host, systemImage: "desktopcomputer").foregroundStyle(Palette.secondary).lineLimit(1)
            .accessibilityLabel("Building on \(host)")
        }
        if let building {
          RunningBuildDetail(env: env, build: building)
        } else {
          VStack(alignment: .leading, spacing: Space.sm) {
            Text("Last Build").font(.stim(.footnote, weight: .semibold)).foregroundStyle(Palette.secondary)
            lastBuild(platform)
          }
          if !readOnly {
            Divider().overlay(Palette.border)
            VStack(alignment: .leading, spacing: Space.sm) {
              Text("Next Build").font(.stim(.footnote, weight: .semibold)).foregroundStyle(Palette.secondary)
              if running != nil {
                Text("Checked after the running build").foregroundStyle(Palette.tertiary)
              } else {
                NextBuildView(entry: entry, recentBuildAt: finishedAt(platform))
              }
            }
          }
        }
        if let totals, platform == platforms.first {
          Divider().overlay(Palette.border)
          Text(totals).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
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

  @ViewBuilder private func runButton(_ platform: String) -> some View {
    let failed = lastBuildRecord(platform)?.status == "failed"
    Button {
      if platform == "macos", let macos = env.macos {
        actions.run("Build \(macos.product)", steps: [StimCommand(macos.runArguments, cwd: env.path)], present: false)
      } else {
        actions.runApp(env, platform: platform)
      }
    } label: {
      Label(failed ? "Rebuild" : "Run", systemImage: "play.fill")
    }
    .buttonStyle(.stim(.primary))
    .fixedSize()
    .disabled(running != nil || actions.active(for: env.path) != nil)
    .help(
      platform == "macos"
        ? "stim macos: builds the Swift package and launches the app"
        : "stim \(platform): the default slot and configuration; builds if needed, installs and launches"
    )
  }

  @ViewBuilder private func lastBuild(_ platform: String) -> some View {
    if let last = lastBuildRecord(platform) {
      TimelineView(.periodic(from: .now, by: 30)) { context in
        VStack(alignment: .leading, spacing: Space.xs) {
          Text(last.summary)
            .font(.stim(.callout, weight: .semibold))
            .foregroundStyle(last.status == "ok" ? Palette.text : Palette.error)
            .fixedSize(horizontal: false, vertical: true)
            .help(last.fingerprint.map { "Fingerprint \($0)" } ?? "")
          if let endedAt = last.endedAt {
            Text(Format.age((fixtureDate ?? context.date).timeIntervalSince(endedAt)))
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
      InlineEmpty("No build recorded")
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
struct RunningBuildDetail: View {
  var env: Workspace
  var build: Build

  var body: some View {
    TimelineView(.buildSeconds(build)) { context in
      let steps = build.phaseSteps(history: env.builds?.builds(for: build.platform) ?? [], now: context.date)
      let (phase, counts) = build.currentPhaseLabel
      let elapsedMs = build.progress(at: context.date).elapsedMs
      let elapsed = Format.clock(ms: elapsedMs)
      let estimate = Format.estimateSuffix(elapsedMs: elapsedMs, expectedMs: build.expectedMs)
      VStack(alignment: .leading, spacing: Space.md) {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
          Text(phase).font(.stim(.footnote, weight: .semibold)).foregroundStyle(Palette.primary)
          if let counts { Text(counts).font(.stim(.footnote)).foregroundStyle(Palette.secondary).lineLimit(1) }
          if let activityMs = build.activityElapsedMs(at: context.date) {
            Text(Format.clock(ms: activityMs)).font(.stim(.footnote)).foregroundStyle(Palette.secondary).monospacedDigit()
          }
          Spacer(minLength: Space.sm)
          (Text(elapsed) + Text(estimate).foregroundStyle(Palette.tertiary))
            .font(.stim(.footnote))
            .monospacedDigit()
        }
        PhaseBar(steps: barSteps(steps), key: build.key, indeterminate: build.waitsWithoutProgress)
      }
      .accessibilityElement(children: .combine)
    }
    if build.phase == "wait", let holder = build.waitingOn {
      WaitingOnButton(path: holder.path, current: env.path)
    }
    if build.waitingFor != nil { SlotWaitText(build: build) }
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
  #if DEBUG
    @Environment(\.fixtureDate) private var fixtureDate
  #else
    private var fixtureDate: Date? { nil }
  #endif
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
            BuildHistoryRow(entry: entry, now: fixtureDate ?? context.date) { open(entry) }
          }
        }
        .padding(.top, Space.xs)
      }
    }
    .onAppear { if fixtureDate != nil { expanded = true } }
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
        Button(expanded ? "Show Fewer" : "Show \(countLabel(diagnostics.count - 1, "more error", plural: "more errors"))") {
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
  var recentBuildAt: Date? = nil

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
          .foregroundStyle(
            plan.refusal != nil
              ? Palette.warning
              : plan.platform == "macos" ? Palette.text : plan.cacheHit == .none ? Palette.warning : Palette.success
          )
          .help(plan.detail ?? "")
        if let placement = plan.placement {
          Text(placement.prefix(1).uppercased() + placement.dropFirst())
            .foregroundStyle(Palette.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
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
      Text(recentBuildAt == nil ? "Not checked yet" : "Built recently").foregroundStyle(Palette.tertiary)
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
