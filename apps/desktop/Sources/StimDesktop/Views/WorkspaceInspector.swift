import StimKit
import SwiftUI

/// The workspace page's details, beside the devices: build, resources, Metro and logs, agents and the build cache.
struct Inspector: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var stats: ProjectStats?
  var machine: MachineUsage?
  var usage: UsageHistory?
  var history: OwnerHistory
  var reportsBundles: Bool
  var showsLogs: Bool
  var toggleLogs: () -> Void

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxxl) {
        BuildSection(cli: cli, env: env)
          .id(env.path)

        ResourcesSection(env: env, machine: machine, history: history, sampled: usage)

        MetroLogsSection(env: env, reportsBundles: reportsBundles, showsLogs: showsLogs, toggleLogs: toggleLogs)

        if let agents = env.agents, !agents.isEmpty {
          AgentSessionsSection(agents: agents)
        }

        if let project = stats?.project, project.ios != nil || project.android != nil {
          VStack(alignment: .leading, spacing: Space.md) {
            SectionLabel(title: "Build cache \u{00B7} project")
            ViewThatFits(in: .horizontal) {
              HStack(alignment: .top, spacing: Space.md) { statCards(project) }
              VStack(spacing: Space.md) { statCards(project) }
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
      Text("\(countLabel(platform.hits, "hit")) \u{00B7} \(countLabel(platform.misses, "miss", plural: "misses"))")
        .foregroundStyle(Palette.secondary)
      if let cold = platform.lastColdBuildMs {
        Text("Last cold \(formatDuration(ms: cold))").foregroundStyle(Palette.secondary)
      }
      if let saved = platform.timeSavedMs {
        Text("Saved \(formatDuration(ms: saved))").foregroundStyle(Palette.primary)
      }
    }
    .padding(Space.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
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
    var usage = env.usage(machine: machine)
    if usage.cpuPercent == nil, let sampled {
      usage.cpuPercent = sampled.latest.cpuPercent
      if sampled.memoryBytes > 0 { usage.memoryMb = Double(sampled.memoryBytes) / 1_048_576 }
    }
    return usage
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
          "memorychip", "Memory", usage.memoryMb.map(formatMemoryMb) ?? "\u{2014}",
          values: history.memoryMb(env.path).isEmpty
            ? sampled.map { $0.memory.map { $0 / 1_048_576 } } ?? [] : history.memoryMb(env.path),
          minimumPeak: 1024)
      }
      if let window {
        Text(window).font(.stim(.caption)).foregroundStyle(Palette.tertiary)
      }
      if !rows.isEmpty {
        ProcessRowsTable(rows: rows)
      }
      if let disk = env.diskBreakdown(format: { formatDisk(Int64($0)) }) {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
          Image(systemName: "internaldrive").foregroundStyle(Palette.secondary)
          Text(disk).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .font(.stim(.footnote))
      }
    }
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
      Text(value).font(.stim(.headline)).monospacedDigit()
      Sparkline(values: values, minimumPeak: minimumPeak).frame(height: 24)
    }
    .padding(Space.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
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
              bundle.tone == .error ? Palette.error : bundle.tone == .tertiary ? Palette.tertiary : Palette.secondary)
            .lineLimit(2)
        }
      }
    }
  }
}
