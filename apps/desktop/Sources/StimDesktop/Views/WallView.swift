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
        VStack(alignment: .leading, spacing: Space.huge) {
          if let project {
            Text(project.name).font(.stim(.title))
          }
          ForEach(live) { env in
            VStack(alignment: .leading, spacing: Space.lg) {
              WorkspaceHeader(
                env: env, project: store.project(of: env), usage: metrics.usage[env.path],
                openLogs: { openLogs(env.path) }
              )
              .onTapGesture { selection = .environment(env.path) }
              ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: Space.xl) {
                  ForEach(env.devices.filter { $0.isRunning || env.runningBuild(for: $0) != nil }) { device in
                    Button { selection = .environment(env.path) } label: {
                      DeviceTile(
                        device: device, screenHeight: tileSize.screenHeight, workspace: env.path,
                        workspaceTitle: env.names.title, build: env.runningBuild(for: device))
                    }
                    .buttonStyle(.plain)
                  }
                }
              }
            }
          }
        }
        .padding(Space.xxxl)
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
    VStack(alignment: .leading, spacing: Space.md) {
      row
      if let build = env.build, build.isRunning {
        BuildProgressBar(build: build).frame(maxWidth: 520)
      }
    }
    .contentShape(Rectangle())
  }

  private var row: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: Space.lg) {
        titleGroup
        Spacer(minLength: 12)
        chips
      }
      VStack(alignment: .leading, spacing: Space.md) {
        titleGroup
        chips
      }
    }
  }

  private var titleGroup: some View {
    HStack(spacing: Space.lg) {
      Text(env.names.title).font(.stim(.headline)).lineLimit(1).truncationMode(.middle)
      if project.name != env.names.title {
        Text(project.name).font(.stim(.callout)).foregroundStyle(Palette.primary).lineLimit(1).fixedSize()
      }
      if let inCheckout = env.names.inCheckout {
        Text(inCheckout).font(.stim(.callout)).foregroundStyle(Palette.tertiary).lineLimit(1).fixedSize()
      }
    }
  }

  private var chips: some View {
    FlowLayout(spacing: Space.md, lineSpacing: Space.sm) {
      if let metro = env.metro {
        Pill(tone: metro.running ? .neutral : .error) {
          StatusDot(color: metro.running ? Palette.success : Palette.error)
          Text("Metro")
          Text(":\(String(metro.port))").font(.stim(.caption, mono: true))
        }
      }
      if let supervisor = env.supervisor, supervisor.healthy != true {
        Pill(tone: .warning) { Text("supervisor unhealthy") }
      }
      if let usage {
        if let cpu = usage.latest.cpuPercent {
          Pill {
            Sparkline(values: usage.cpu, minimumPeak: 100).frame(width: 34, height: 12)
            Text("CPU")
            Text(formatPercent(cpu)).font(.stim(.caption, mono: true))
          }
          .help("CPU of the workspace's processes, simulators and emulators, as a percent of one core")
        }
        Pill {
          Sparkline(values: usage.resident, minimumPeak: 1_073_741_824).frame(width: 34, height: 12)
          Text("RAM")
          Text(formatMemory(usage.latest.residentBytes)).font(.stim(.caption, mono: true))
        }
        .help("Resident memory of the workspace's processes, simulators and emulators")
      }
      if let mb = env.memoryMb, mb > 0 {
        Pill { Text(formatGigabytes(mb: mb)) }
          .help("Committed memory estimate from stim status")
      }
      if let errors = env.logs?.errorsSinceMarker {
        Button(action: openLogs) {
          Pill(tone: errors > 0 ? .error : .neutral) { Text(countLabel(errors, "error")) }
        }
        .buttonStyle(.plain)
        .help("Open logs")
      }
    }
  }
}
