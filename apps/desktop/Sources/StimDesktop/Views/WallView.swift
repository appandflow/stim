import StimKit
import SwiftUI

struct WallView: View {
  @ObservedObject var store: StatusStore
  @ObservedObject var metrics: MetricsStore
  var project: Project?
  @Binding var selection: SidebarItem?
  var openLogs: (String) -> Void
  @AppStorage(AppPreferences.Key.tileSize) private var tileSize = TileSize.medium

  var body: some View {
    let live = store.environments(in: project).filter { $0.live || $0.build?.isRunning == true }
    if store.payload == nil {
      if let error = store.error {
        EmptyState(title: "Cannot read stim status", message: error, showsHero: true)
      } else {
        ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    } else if live.isEmpty {
      EmptyState(
        title: project.map { "Nothing running in \($0.name)" } ?? "Nothing running",
        message: "Devices appear here when an agent runs stim ios or stim android in a workspace.",
        showsHero: true)
    } else {
      ScrollView {
        VStack(alignment: .leading, spacing: 32) {
          if let project {
            Text(project.name).font(Theme.heading(22))
          }
          ForEach(live) { env in
            VStack(alignment: .leading, spacing: 12) {
              WorkspaceHeader(
                env: env, project: store.project(of: env), usage: metrics.usage[env.path],
                openLogs: { openLogs(env.path) }
              )
              .onTapGesture { selection = .environment(env.path) }
              ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 16) {
                  ForEach(env.devices.filter { $0.isRunning || env.runningBuild(for: $0) != nil }) { device in
                    Button { selection = .environment(env.path) } label: {
                      DeviceTile(device: device, screenHeight: tileSize.screenHeight, workspace: env.path)
                    }
                    .buttonStyle(.plain)
                  }
                }
              }
            }
          }
        }
        .padding(28)
      }
    }
  }
}

struct WorkspaceHeader: View {
  var env: Workspace
  var project: Project
  var usage: UsageHistory?
  var openLogs: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      row
      if let build = env.build, build.isRunning {
        BuildProgressBar(build: build).frame(maxWidth: 520)
      }
    }
    .contentShape(Rectangle())
  }

  private var row: some View {
    HStack(spacing: 12) {
      Text(env.names.title).font(Theme.heading(16))
      Text(project.name).font(Theme.body(12)).foregroundStyle(Theme.primary)
      Text(env.names.subtitle).font(Theme.body(12)).foregroundStyle(Theme.tertiary)
      Spacer()
      if let metro = env.metro {
        Chip(tint: metro.running ? nil : Theme.error) {
          StatusDot(color: metro.running ? Theme.live : Theme.error)
          Text("Metro")
          Text(":\(String(metro.port))").font(Theme.mono())
        }
      }
      if let supervisor = env.supervisor {
        Chip(tint: supervisor.healthy == true ? nil : Theme.warn) {
          Text("\(supervisor.mode ?? "supervisor") \u{00B7} \(supervisor.healthy == true ? "healthy" : "unhealthy")")
        }
      }
      if let usage {
        if let cpu = usage.latest.cpuPercent {
          Chip {
            Sparkline(values: usage.cpu, minimumPeak: 100).frame(width: 34, height: 12)
            Text("CPU")
            Text(formatPercent(cpu)).font(Theme.mono())
          }
          .help("CPU of the workspace's processes, simulators and emulators, as a percent of one core")
        }
        Chip {
          Sparkline(values: usage.resident, minimumPeak: 1_073_741_824).frame(width: 34, height: 12)
          Text("RAM")
          Text(formatMemory(usage.latest.residentBytes)).font(Theme.mono())
        }
        .help("Resident memory of the workspace's processes, simulators and emulators")
      }
      if let mb = env.memoryMb, mb > 0 {
        Chip { Text(formatGigabytes(mb: mb)) }
          .help("Committed memory estimate from stim status")
      }
      if let errors = env.logs?.errorsSinceMarker {
        Button(action: openLogs) {
          Chip(tint: errors > 0 ? Theme.error : nil) { Text(errors == 1 ? "1 error" : "\(errors) errors") }
        }
        .buttonStyle(.plain)
        .help("Open logs")
      }
    }
  }
}
