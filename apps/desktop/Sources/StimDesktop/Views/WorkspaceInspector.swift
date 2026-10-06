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
  var openLogs: (LogQuery) -> Void
  var openBuild: (BuildSheetSelection) -> Void

  private var agentSessions: [AgentSession] { AgentSession.associated(agents: env.agents, endedAgents: env.endedAgents) }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxxl) {
        if env.runPlatforms.contains(where: { $0 == "ios" || $0 == "android" }) || env.macos != nil {
          BuildSection(cli: cli, env: env, openLogs: openLogs, openBuild: openBuild)
            .id(env.path)
        }

        ResourcesSection(env: env, machine: machine, history: history, sampled: usage)

        MetroLogsSection(
          env: env, reportsBundles: reportsBundles,
          openLogs: {
            var query = LogQuery()
            query.sources = [.metro]
            openLogs(query)
          })

        VStack(alignment: .leading, spacing: Space.md) {
          HStack {
            SectionLabel(title: "App / native logs")
            Spacer(minLength: Space.sm)
            Button("Show logs") {
              var query = LogQuery()
              query.sources = [.client, .device]
              openLogs(query)
            }
            .buttonStyle(.stim())
            .fixedSize()
          }
          Text("App runtime and device output").foregroundStyle(Palette.secondary)
        }

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
    BuildCacheStatCard(title: title, platform: platform)
  }
}

struct BuildCacheStatCard: View {
  var title: String
  var platform: ProjectStats.Platform
  var subtitle: String? = nil

  var body: some View {
    Card(radius: Radius.control, border: nil, clipsContent: false) {
      VStack(alignment: .leading, spacing: Space.sm) {
        Text(title).foregroundStyle(Palette.secondary)
        if let subtitle { Text(subtitle).font(.stim(.footnote)).foregroundStyle(Palette.tertiary) }
        Text("\(Int((platform.hitRate * 100).rounded()))%").font(.stim(.title))
        StimProgressBar(value: platform.hitRate)
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
    }
  }
}

/// The workspace's CPU, memory and disk, their recent history, and every process that counts toward them.
struct ResourcesSection: View {
  var env: Workspace
  var machine: MachineUsage?
  var history: OwnerHistory
  var sampled: UsageHistory?
  var page: WorktreePage? = nil
  var samples: [String: UsageHistory] = [:]

  private var usage: WorkspaceUsage {
    if let page {
      return page.usage(
        machine: machine,
        sampled: samples.mapValues {
          WorkspaceUsage(cpuPercent: $0.latest.cpuPercent, memoryMb: $0.isFootprint ? Double($0.memoryBytes) / 1_048_576 : nil)
        })
    }
    return env.usage(machine: machine).filling(
      cpuPercent: sampled?.latest.cpuPercent,
      footprintMb: sampled.flatMap { $0.isFootprint ? Double($0.memoryBytes) / 1_048_576 : nil })
  }

  var body: some View {
    let usage = usage
    let rows = (page?.apps ?? [env]).flatMap { $0.processRows(machine: machine) }
    VStack(alignment: .leading, spacing: Space.md) {
      SectionLabel(title: "Resources")
      HStack(alignment: .top, spacing: Space.md) {
        chart(
          "cpu", "CPU", usage.cpuPercent.map(formatPercent) ?? "\u{2014}",
          values: cpuHistory, minimumPeak: 100)
        chart(
          "memorychip", "Memory", usage.memoryMb.map(Format.memoryMb) ?? "\u{2014}",
          values: memoryHistory,
          minimumPeak: 1024)
      }
      if !rows.isEmpty {
        ProcessRowsTable(rows: rows)
      }
      if let disk = page == nil ? env.diskBreakdown : page?.diskBreakdown {
        DiskCard(breakdown: disk)
      }
    }
  }

  private var cpuHistory: [Double] {
    if let page {
      return WorktreePage.summedHistory(
        page.apps.map { app in
          history.cpu(app.path).isEmpty ? samples[app.path]?.cpu ?? [] : history.cpu(app.path)
        })
    }
    return history.cpu(env.path).isEmpty ? sampled?.cpu ?? [] : history.cpu(env.path)
  }

  private var memoryHistory: [Double] {
    if let page {
      return WorktreePage.summedHistory(
        page.apps.map { app in
          let measured = history.memoryMb(app.path)
          return measured.isEmpty
            ? samples[app.path].flatMap { $0.isFootprint ? $0.memory.map { $0 / 1_048_576 } : nil } ?? [] : measured
        })
    }
    return history.memoryMb(env.path).isEmpty
      ? sampled.flatMap { $0.isFootprint ? $0.memory.map { $0 / 1_048_576 } : nil } ?? [] : history.memoryMb(env.path)
  }

  private func chart(_ icon: String, _ title: String, _ value: String, values: [Double], minimumPeak: Double)
    -> some View
  {
    Card(radius: Radius.control, border: nil, clipsContent: false) {
      VStack(alignment: .leading, spacing: Space.xs) {
        Label(title, systemImage: icon).foregroundStyle(Palette.secondary)
        Text(value).font(.stim(.headline)).monospacedDigit()
        Sparkline(values: values, minimumPeak: minimumPeak).frame(height: 24)
      }
      .padding(Space.md)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
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
    Card(radius: Radius.control, border: nil, clipsContent: false) {
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
              StatusDot(color: color(part))
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
    }
    .help("The worktree folder, with node_modules counted on its own, plus Stim's build folder for this workspace")
  }
}

/// Metro's port, health, latest bundle and logs.
struct MetroLogsSection: View {
  var env: Workspace
  var reportsBundles: Bool
  var showsHeading = true
  var appLabel: String? = nil
  var openLogs: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      if showsHeading {
        HStack {
          SectionLabel(title: "Metro")
          Spacer(minLength: Space.sm)
          Button("Show logs", action: openLogs)
            .buttonStyle(.stim())
            .fixedSize()
            .help("Open Metro logs in the workspace log viewer")
        }
      }
      if let metro = env.metro, let health = env.metroHealth {
        HStack(spacing: Space.sm) {
          StatusDot(
            color: health == .healthy ? Palette.success : health == .unhealthy ? Palette.error : Palette.tertiary,
            filled: health != .stopped)
          if let appLabel { Text(appLabel).font(.stim(.callout, weight: .semibold)) }
          Text("Metro").font(.stim(.callout, weight: .semibold))
          Text(":\(String(metro.port))").foregroundStyle(Palette.secondary).monospacedDigit()
          Text(health.rawValue).foregroundStyle(Palette.tertiary)
          if !showsHeading {
            Spacer(minLength: Space.sm)
            Button("Show logs", action: openLogs).buttonStyle(.stim()).fixedSize()
          }
        }
        .help(env.supervisor.map { "\($0.mode ?? "supervisor") \u{00B7} \(health.rawValue)" } ?? "Metro \(health.rawValue)")
      } else {
        InlineEmpty("No dev server")
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

struct WorktreeInspector: View {
  var cli: Task<StimCLI, Never>
  var page: WorktreePage
  var stats: [String: Fetched<ProjectStats>]
  var machine: MachineUsage?
  var sampled: [String: UsageHistory]
  var history: OwnerHistory
  var reportsBundles: Bool
  var openLogs: (Workspace?, LogQuery) -> Void
  var openBuild: (BuildSheetSelection) -> Void

  private var cacheEntries: [WorktreePage.Entry] {
    ["ios", "android"].flatMap { platform in
      page.apps.filter { app in
        let project = stats[app.path]?.value?.project
        return platform == "ios" ? project?.ios != nil : project?.android != nil
      }.map { .init(path: $0.path, platform: platform) }
    }
  }

  var body: some View {
    let labeledApps = Array(zip(page.apps, page.appLabels))
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxxl) {
        if !page.buildEntries.isEmpty {
          VStack(alignment: .leading, spacing: Space.md) {
            SectionLabel(title: "Build")
            ForEach(page.buildEntries) { entry in
              if let app = page.apps.first(where: { $0.path == entry.path }) {
                buildEntry(entry, app: app)
              }
            }
          }
        }
        ResourcesSection(env: page.apps[0], machine: machine, history: history, sampled: nil, page: page, samples: sampled)
        VStack(alignment: .leading, spacing: Space.md) {
          SectionLabel(title: "Metro")
          let metros = labeledApps.filter { $0.0.metro != nil }
          if metros.isEmpty {
            InlineEmpty("No dev server")
          } else {
            ForEach(metros, id: \.0.path) { app, label in
              MetroLogsSection(
                env: app, reportsBundles: reportsBundles, showsHeading: false, appLabel: label,
                openLogs: {
                  var query = LogQuery()
                  query.sources = [.metro]
                  openLogs(app, query)
                })
            }
          }
        }
        VStack(alignment: .leading, spacing: Space.md) {
          HStack {
            SectionLabel(title: "App / native logs")
            Spacer(minLength: Space.sm)
            Button("Show logs") {
              var query = LogQuery()
              query.sources = [.client, .device]
              openLogs(nil, query)
            }.buttonStyle(.stim()).fixedSize()
          }
          Text("App runtime and device output").foregroundStyle(Palette.secondary)
        }
        if !page.agents.isEmpty { AgentSessionsSection(agents: page.agents) }
        if !cacheEntries.isEmpty || stats.values.contains(where: { $0.error != nil }) {
          VStack(alignment: .leading, spacing: Space.md) {
            SectionLabel(title: "Build cache \u{00B7} project")
            ForEach(page.apps) { app in
              if let error = stats[app.path]?.error {
                Label("Could not load stats: \(error)", systemImage: "exclamationmark.triangle")
                  .foregroundStyle(Palette.warning).textSelection(.enabled)
              }
            }
            ForEach(cacheEntries) { entry in
              if let project = stats[entry.path]?.value?.project,
                let platform = entry.platform == "ios" ? project.ios : project.android
              {
                BuildCacheStatCard(
                  title: platformName(entry.platform), platform: platform,
                  subtitle: page.subtitle(for: entry, among: cacheEntries))
              }
            }
          }
        }
        let warnings = page.apps.flatMap(\.warnings)
        if !warnings.isEmpty {
          VStack(alignment: .leading, spacing: Space.md) {
            SectionLabel(title: "Warnings")
            ForEach(Array(warnings.enumerated()), id: \.offset) { _, warning in
              Label(abbreviatingHome(warning), systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Palette.warning).textSelection(.enabled)
            }
          }
        }
      }
      .font(.stim(.callout)).padding(Space.xxl)
    }
  }

  @ViewBuilder private func buildEntry(_ entry: WorktreePage.Entry, app: Workspace) -> some View {
    let section = BuildSection(
      cli: cli, env: app, openLogs: { openLogs(app, $0) }, openBuild: openBuild, onlyPlatform: entry.platform,
      projectSubtitle: page.subtitle(for: entry, among: page.buildEntries))
    if entry.platform == "macos" {
      Card(radius: Radius.control, border: nil, clipsContent: false) {
        section.padding(Space.lg).frame(maxWidth: .infinity, alignment: .leading)
      }
    } else {
      section
    }
  }
}
