import StimKit
import SwiftUI

/// The workspace page's details, beside the devices: build, resources, Metro and logs, agents and the build cache.
struct Inspector: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var stats: Fetched<ProjectStats>
  var machine: MachineUsage?
  var usage: UsageHistory?
  var history: OwnerHistory
  var reportsBundles: Bool
  var showsLogs: Bool
  var toggleLogs: () -> Void

  private var agentSessions: [AgentSession] { AgentSession.associated(agents: env.agents, endedAgents: env.endedAgents) }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxxl) {
        BuildSection(cli: cli, env: env)
          .id(env.path)

        ResourcesSection(env: env, machine: machine, history: history, sampled: usage)

        MetroLogsSection(env: env, reportsBundles: reportsBundles, showsLogs: showsLogs, toggleLogs: toggleLogs)

        if !agentSessions.isEmpty {
          AgentSessionsSection(agents: agentSessions)
        }

        let project = stats.value?.project.flatMap { $0.ios != nil || $0.android != nil ? $0 : nil }
        if project != nil || stats.error != nil {
          VStack(alignment: .leading, spacing: Space.md) {
            SectionLabel(title: "Build cache \u{00B7} project")
            if let error = stats.error {
              Label("Could not load stats: \(error)", systemImage: "exclamationmark.triangle")
                .foregroundStyle(Palette.warning)
                .textSelection(.enabled)
            }
            if let project {
              ViewThatFits(in: .horizontal) {
                HStack(spacing: Space.md) { statCards(project) }.fixedSize(horizontal: false, vertical: true)
                VStack(spacing: Space.md) { statCards(project) }
              }
            }
          }
        }

        if !env.warnings.isEmpty {
          VStack(alignment: .leading, spacing: Space.md) {
            SectionLabel(title: "Warnings")
            ForEach(env.warnings, id: \.self) { warning in
              Label(abbreviatingHome(warning), systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Palette.warning)
                .textSelection(.enabled)
            }
          }
        }
      }
      .font(.stim(.callout))
      .padding(Space.xxl)
    }
  }

  @ViewBuilder private func statCards(_ project: ProjectStats.Scope) -> some View {
    if let ios = project.ios { statCard("iOS", ios) }
    if let android = project.android { statCard("Android", android) }
  }

  private func statCard(_ title: String, _ platform: ProjectStats.Platform) -> some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Text(title).foregroundStyle(Palette.secondary)
      Text("\(Int((platform.hitRate * 100).rounded()))%").font(.stim(.title))
      ProgressView(value: platform.hitRate).tint(Palette.accent)
      Text(countLabel(platform.hits, "hit")).foregroundStyle(Palette.secondary)
      Text(countLabel(platform.misses, "miss", plural: "misses")).foregroundStyle(Palette.secondary)
      if let cold = platform.lastColdBuildMs {
        Text("Last cold \(Format.elapsed(ms: cold))").foregroundStyle(Palette.secondary)
      }
      if let saved = platform.timeSavedMs, saved >= 1000 {
        Text("Saved \(Format.elapsed(ms: saved))").foregroundStyle(Palette.primary)
      }
    }
    .padding(Space.lg)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
  }
}

/// The workspace's CPU, memory and disk, their recent history, and every process that counts toward them.
struct ResourcesSection: View {
  var env: Workspace
  var machine: MachineUsage?
  var history: OwnerHistory
  var sampled: UsageHistory?

  private var usage: WorkspaceUsage {
    env.usage(machine: machine).filling(
      cpuPercent: sampled?.latest.cpuPercent,
      footprintMb: sampled.flatMap { $0.isFootprint ? Double($0.memoryBytes) / 1_048_576 : nil })
  }

  var body: some View {
    let usage = usage
    let rows = env.processRows(machine: machine)
    VStack(alignment: .leading, spacing: Space.md) {
      SectionLabel(title: "Resources")
      HStack(alignment: .top, spacing: Space.md) {
        chart(
          "cpu", "CPU", usage.cpuPercent.map(formatPercent) ?? "\u{2014}",
          values: history.cpu(env.path).isEmpty ? sampled?.cpu ?? [] : history.cpu(env.path), minimumPeak: 100)
        chart(
          "memorychip", "Memory", usage.memoryMb.map(Format.memoryMb) ?? "\u{2014}",
          values: history.memoryMb(env.path).isEmpty
            ? sampled.flatMap { $0.isFootprint ? $0.memory.map { $0 / 1_048_576 } : nil } ?? []
            : history.memoryMb(env.path),
          minimumPeak: 1024)
      }
      if let window {
        Text(window).font(.stim(.caption)).foregroundStyle(Palette.tertiary)
      }
      if !rows.isEmpty {
        ProcessRowsTable(rows: rows)
      }
      if let disk = env.diskBreakdown {
        DiskCard(breakdown: disk)
      }
    }
  }

  private var window: String? {
    guard let span = history.span(env.path), span >= 60 else { return nil }
    return "Last \(Format.duration(span)), sampled while Stim Desktop is on screen"
  }

  private func chart(_ icon: String, _ title: String, _ value: String, values: [Double], minimumPeak: Double)
    -> some View
  {
    VStack(alignment: .leading, spacing: Space.xs) {
      Label(title, systemImage: icon).foregroundStyle(Palette.secondary)
      Text(value).font(.stim(.headline)).monospacedDigit()
      Sparkline(values: values, minimumPeak: minimumPeak).frame(height: 24)
    }
    .padding(Space.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
  }
}

private struct DiskCard: View {
  var breakdown: DiskBreakdown

  private func color(_ part: DiskBreakdown.Part) -> Color {
    switch part.kind {
    case .nodeModules: Palette.accent
    case .worktree: Palette.tertiary
    case .build: Palette.info
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Label("Disk", systemImage: "internaldrive").foregroundStyle(Palette.secondary)
      Text(Format.fileSize(Int64(breakdown.total))).font(.stim(.headline)).monospacedDigit()
      GeometryReader { geo in
        HStack(spacing: 1) {
          ForEach(breakdown.parts) { part in
            Rectangle().fill(color(part))
              .frame(width: max(2, geo.size.width * CGFloat(part.bytes / max(breakdown.total, 1))))
          }
        }
        .frame(width: geo.size.width, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: Radius.small))
      }
      .frame(height: 6)
      .accessibilityHidden(true)
      VStack(spacing: Space.xs) {
        ForEach(breakdown.parts) { part in
          HStack(spacing: Space.sm) {
            Circle().fill(color(part)).frame(width: 7, height: 7)
            Text(breakdown.label(of: part))
            Spacer(minLength: Space.sm)
            Text(Format.fileSize(Int64(part.bytes))).monospacedDigit().foregroundStyle(Palette.secondary)
          }
          .accessibilityElement(children: .combine)
        }
      }
      .font(.stim(.footnote))
    }
    .padding(Space.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
    .help("The worktree folder, with node_modules counted on its own, plus Stim's build folder for this workspace")
  }
}

/// Metro's port and health, the error count, the latest bundle, and the button that shows or hides the logs.
struct MetroLogsSection: View {
  var env: Workspace
  var reportsBundles: Bool
  var showsLogs: Bool
  var toggleLogs: () -> Void

  var body: some View {
    let errors = env.logs?.errorsSinceMarker ?? 0
    VStack(alignment: .leading, spacing: Space.md) {
      HStack {
        SectionLabel(title: "Metro & logs")
        Spacer(minLength: Space.sm)
        Button(action: toggleLogs) {
          HStack(spacing: Space.xs) {
            Text(showsLogs ? "Hide logs" : "Show logs")
            if errors > 0, !showsLogs {
              Pill(String(errors), tone: .error, size: .small)
            }
          }
        }
        .buttonStyle(.stim())
        .fixedSize()
        .help(showsLogs ? "Hide the logs below the devices" : "Show the workspace's logs below the devices")
      }
      if let metro = env.metro, let health = env.metroHealth {
        HStack(spacing: Space.sm) {
          StatusDot(
            color: health == .healthy ? Palette.success : health == .unhealthy ? Palette.error : Palette.tertiary,
            filled: health != .stopped)
          Text("Metro").font(.stim(.callout, weight: .semibold))
          Text(":\(String(metro.port))").foregroundStyle(Palette.secondary).monospacedDigit()
          Text(health.rawValue).foregroundStyle(Palette.tertiary)
        }
        .help(env.supervisor.map { "\($0.mode ?? "supervisor") \u{00B7} \(health.rawValue)" } ?? "Metro \(health.rawValue)")
      } else {
        Text("No dev server").foregroundStyle(Palette.tertiary)
      }
      if let count = env.logs?.errorsSinceMarker {
        HStack(spacing: Space.sm) {
          StatusDot(color: count > 0 ? Palette.error : Palette.border)
          Text(countLabel(count, "error")).foregroundStyle(count > 0 ? Palette.error : Palette.secondary)
        }
        .help("Errors in the workspace's logs since the last marker")
      }
      TimelineView(.periodic(from: .now, by: 15)) { context in
        if let bundle = env.bundleLine(now: context.date, reportsBundles: reportsBundles) {
          Text(bundle.text)
            .foregroundStyle(
              bundle.tone == .error ? Palette.error : bundle.tone == .tertiary ? Palette.tertiary : Palette.secondary
            )
            .lineLimit(2)
        }
      }
    }
  }
}
