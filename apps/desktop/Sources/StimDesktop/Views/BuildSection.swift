import StimKit
import StimStores
import SwiftUI

/// Each platform the workspace runs: the running build's phases, output and cache miss, or the last build and what
/// `stim <platform> --plan` predicts for the next one, with Check and Run. Opening the section checks every platform
/// it shows, unless a build is running.
struct BuildSection: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  @EnvironmentObject private var checks: BuildPlanChecks
  @EnvironmentObject private var actions: ActionCenter

  private var running: Build? { env.build.flatMap { $0.isRunning ? $0 : nil } }

  private func buildKey(_ platform: String) -> String { env.lastBuilds?.build(for: platform)?.planKey ?? "" }

  private var platforms: [String] {
    guard let running, !env.runPlatforms.contains(running.platform) else { return env.runPlatforms }
    return env.runPlatforms + [running.platform]
  }

  private var trigger: [String] {
    [running == nil ? "idle" : "building"] + platforms.map(buildKey)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      SectionLabel(title: "Build")
      ForEach(platforms, id: \.self) { platform in
        card(platform)
      }
    }
    .onAppear(perform: checkUsed)
    .onChange(of: trigger) { checkUsed() }
    .onDisappear { checks.cancel(workspace: env.path) }
  }

  private func checkUsed() {
    if running != nil { return checks.cancel(workspace: env.path) }
    checks.check(workspace: env.path, builds: Dictionary(uniqueKeysWithValues: platforms.map { ($0, buildKey($0)) }))
  }

  private func card(_ platform: String) -> some View {
    let entry = checks.entry(workspace: env.path, platform: platform)
    let building = running.flatMap { $0.platform == platform ? $0 : nil }
    return VStack(alignment: .leading, spacing: Space.sm) {
      HStack(spacing: Space.sm) {
        PlatformGlyph(platform: platform, size: 12, color: building == nil ? Palette.text : Palette.primary)
        Text(building == nil ? platformName(platform) : "Building \(platformName(platform))")
          .font(.stim(.callout, weight: .semibold))
          .lineLimit(1)
        if let building { BuildOutcomeBadge(build: building) }
        Spacer()
        if building == nil { buttons(platform, entry: entry) }
      }
      if let host = building?.remote(at: Date())?.host {
        Label("on \(host)", systemImage: "desktopcomputer").foregroundStyle(Palette.secondary).lineLimit(1)
      }
      if let building {
        RunningBuildDetail(cli: cli, env: env, build: building)
      } else {
        lastBuild(platform)
        if running != nil {
          Text("Next build: checked after the running build").foregroundStyle(Palette.tertiary)
        } else {
          nextBuild(entry)
        }
      }
      let history = env.builds?.builds(for: platform) ?? []
      if !history.isEmpty {
        BuildHistoryList(entries: history, workspace: env.path)
      }
    }
    .padding(Space.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: Radius.control).fill(building == nil ? Palette.surface : Palette.primary.opacity(0.06)))
  }

  @ViewBuilder private func buttons(_ platform: String, entry: BuildPlanChecks.Entry?) -> some View {
    Button {
      checks.check(workspace: env.path, builds: [platform: buildKey(platform)], force: true)
    } label: {
      Label("Check", systemImage: "magnifyingglass")
    }
    .buttonStyle(.stim())
    .fixedSize()
    .disabled(running != nil || entry?.state == .checking || actions.active(for: env.path) != nil)
    .help("stim \(platform) --plan: predict the next build from the fingerprint and caches, without building")
    let failed = env.lastBuilds?.build(for: platform)?.status == "failed"
    Button {
      actions.runApp(env, platform: platform)
    } label: {
      Label(failed ? "Rebuild" : "Run", systemImage: "play.fill")
    }
    .buttonStyle(.stim(.primary))
    .fixedSize()
    .disabled(running != nil || actions.active(for: env.path) != nil)
    .help("stim \(platform) with no options: the default slot and configuration; builds if needed, installs and launches")
  }

  @ViewBuilder private func lastBuild(_ platform: String) -> some View {
    if let last = env.lastBuilds?.build(for: platform) {
      TimelineView(.periodic(from: .now, by: 30)) { context in
        Text(
          "Last: \(last.summary)\(last.endedAt.map { " \u{00B7} \(Format.age(context.date.timeIntervalSince($0)))" } ?? "")"
        )
        .foregroundStyle(last.status == "ok" ? Palette.secondary : Palette.error)
        .help(last.fingerprint.map { "Fingerprint \($0)" } ?? "")
      }
      OffloadFallbackLine(build: last)
      if let diagnostics = last.diagnostics, !diagnostics.isEmpty {
        BuildDiagnosticsView(diagnostics: diagnostics, workspace: env.path)
      }
      if let reason = last.missReason {
        MissReasonButton(reason: reason, help: "Why this build missed the cache")
      }
    } else {
      Text("No build recorded").foregroundStyle(Palette.tertiary)
    }
  }

  @ViewBuilder
  private func checkedAt(_ date: Date?) -> some View {
    if let date {
      TimelineView(.periodic(from: .now, by: 30)) { context in
        Text("Checked \(Format.age(context.date.timeIntervalSince(date)))").foregroundStyle(Palette.tertiary)
      }
    }
  }

  @ViewBuilder
  private func nextBuild(_ entry: BuildPlanChecks.Entry?) -> some View {
    switch entry?.state {
    case .checking:
      HStack(spacing: Space.sm) {
        ProgressView().controlSize(.mini)
        Text("Checking next build\u{2026}").foregroundStyle(Palette.tertiary)
      }
    case .done(.plan(let plan)):
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text("Next build: \(plan.nextBuild)")
          .foregroundStyle(plan.refusal != nil || plan.cacheHit == .none ? Palette.warning : Palette.success)
          .help(plan.detail ?? "")
        checkedAt(entry?.checkedAt)
        if let reason = plan.missReason {
          MissReasonButton(reason: reason, help: "Why the next build would miss the cache")
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
      EmptyView()
    }
  }
}

/// A running build: the phase and its counts, elapsed over the estimate, the phase bar and checklist, why the
/// cache missed, and the latest output.
private struct RunningBuildDetail: View {
  var cli: Task<StimCLI, Never>
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
        if namesPhases(steps) {
          PhaseChecklist(steps: steps)
        }
      }
      .accessibilityElement(children: .combine)
    }
    if let miss = build.missReason {
      MissReasonButton(reason: miss, help: "Why this build missed the cache")
      if let note = build.recheckNote {
        Text(note).font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
      }
    }
    BuildOutputTail(cli: cli, workspace: env.path, build: build, limit: 6)
      .padding(Space.md)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.sidebar))
  }
}

private struct BuildHistoryList: View {
  var entries: [BuildHistoryEntry]
  var workspace: String
  @State private var expanded = false

  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      TimelineView(.periodic(from: .now, by: 30)) { context in
        VStack(alignment: .leading, spacing: Space.xxs) {
          ForEach(entries, id: \.self) { entry in
            BuildHistoryRow(entry: entry, workspace: workspace, now: context.date)
          }
        }
        .padding(.top, Space.xs)
      }
    } label: {
      Text("Recent builds (\(entries.count))").foregroundStyle(Palette.secondary)
    }
  }
}

struct BuildHistoryRow: View {
  var entry: BuildHistoryEntry
  var workspace: String
  var now: Date
  @State private var expanded = false

  private var color: Color {
    switch entry.result {
    case "succeeded": return Palette.success
    case "failed": return Palette.error
    default: return Palette.warning
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      Button {
        expanded.toggle()
      } label: {
        VStack(alignment: .leading, spacing: 1) {
          HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(entry.outcome)
              .foregroundStyle(entry.result == "succeeded" ? Palette.secondary : color)
              .lineLimit(1)
            Spacer(minLength: 4)
            Text(
              [
                entry.build.durationMs.map { Format.elapsed(ms: $0) },
                entry.build.endedAt.map { Format.age(now.timeIntervalSince($0)) },
              ]
              .compactMap { $0 }.joined(separator: " \u{00B7} ")
            )
            .foregroundStyle(Palette.tertiary)
            .fixedSize()
            Image(systemName: expanded ? "chevron.down" : "chevron.right").foregroundStyle(Palette.tertiary)
          }
          if let detail = entry.detail {
            Text(detail).foregroundStyle(Palette.tertiary).lineLimit(1).padding(.leading, Space.lg)
          }
        }
      }
      .buttonStyle(.hoverRow(outset: Space.xs))
      if expanded {
        VStack(alignment: .leading, spacing: Space.xs) {
          let facts = [entry.configuration, entry.build.fingerprint.map { "fingerprint \($0.prefix(8))" }]
            .compactMap { $0 }
          if !facts.isEmpty {
            Text(facts.joined(separator: " \u{00B7} ")).foregroundStyle(Palette.tertiary)
          }
          if let phases = entry.phaseLine {
            Text(phases).foregroundStyle(Palette.tertiary)
          }
          OffloadFallbackLine(build: entry.build)
          if let diagnostics = entry.build.diagnostics, !diagnostics.isEmpty {
            BuildDiagnosticsView(diagnostics: diagnostics, workspace: workspace)
          }
          if let reason = entry.build.missReason {
            MissReasonButton(reason: reason, help: "Why this build missed the cache")
          }
        }
        .padding(.leading, Space.lg)
      }
    }
  }
}

/// Why a run that considered offloading built here, in a few words; the tooltip holds the whole reason.
struct OffloadFallbackLine: View {
  var build: LastBuild

  var body: some View {
    if let line = build.fallbackLine {
      Label(line.text, systemImage: "desktopcomputer")
        .foregroundStyle(Palette.secondary)
        .help(line.reason)
    }
  }
}

struct BuildDiagnosticsView: View {
  var diagnostics: [BuildDiagnostic]
  var workspace: String
  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      ForEach(Array((expanded ? diagnostics : [diagnostics[0]]).enumerated()), id: \.offset) { _, diagnostic in
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

struct MissReasonButton: View {
  var reason: BuildMissReason
  var help: String
  @State private var shown = false

  var body: some View {
    Button {
      shown.toggle()
    } label: {
      HStack(spacing: Space.xs) {
        Text("Why: \(reason.summary)").multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        Image(systemName: "info.circle")
      }
      .foregroundStyle(Palette.warning)
    }
    .buttonStyle(.hoverRow(outset: Space.xs))
    .help(help)
    .popover(isPresented: $shown, arrowEdge: .bottom) {
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
