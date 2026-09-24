import StimKit
import SwiftUI

enum SidebarItem: Hashable {
  case wall
  case project(Project)
  case environment(String)
  case attention
}

struct RootView: View {
  @StateObject private var store: StatusStore
  @StateObject private var metrics: MetricsStore
  @State private var selection: SidebarItem? = .wall
  @State private var projectFilter: Project?

  init() {
    let store = StatusStore()
    _store = StateObject(wrappedValue: store)
    _metrics = StateObject(wrappedValue: MetricsStore(status: store))
  }

  var body: some View {
    NavigationSplitView {
      Sidebar(store: store, selection: $selection, projectFilter: projectFilter)
        .navigationSplitViewColumnWidth(min: 240, ideal: 272)
    } detail: {
      detail
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
    }
    .toolbar {
      ToolbarItem(placement: .primaryAction) { MachineSummary(store: store, metrics: metrics) }
    }
    .toolbarBackground(Theme.background, for: .windowToolbar)
    .tint(Theme.purple)
    .font(Theme.body())
    .foregroundStyle(Theme.text)
    .preferredColorScheme(.dark)
    .onAppear {
      store.start()
      metrics.start()
    }
    .onChange(of: selection) { _, item in
      switch item {
      case .wall: projectFilter = nil
      case .project(let project): projectFilter = project
      default: break
      }
    }
  }

  @ViewBuilder private var detail: some View {
    switch selection {
    case .environment(let path):
      if let env = store.payload?.environments.first(where: { $0.path == path }) {
        WorkspaceDetail(env: env, usage: metrics.usage[env.path])
      } else {
        EmptyState(title: "Workspace gone", message: "stim status no longer reports this workspace.")
      }
    case .attention:
      AttentionView(store: store)
    default:
      WallView(store: store, metrics: metrics, project: projectFilter, selection: $selection)
    }
  }
}

struct MachineSummary: View {
  @ObservedObject var store: StatusStore
  @ObservedObject var metrics: MetricsStore
  @State private var showsDisk = false

  var body: some View {
    HStack(spacing: 18) {
      if let error = store.error {
        Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Theme.warn)
      }
      if let cap = store.payload?.capacity {
        HStack(spacing: 6) {
          StatusDot(color: Theme.live)
          Text("\(cap.liveCount) live")
        }
        HStack(spacing: 8) {
          Text("Memory").foregroundStyle(Theme.secondary).fixedSize()
          ProgressView(value: min(1, Double(cap.committedMb) / Double(max(1, cap.totalMemoryMb))))
            .tint(cap.overCapacity ? Theme.warn : Theme.lavender)
            .frame(width: 70)
          Text("\(formatGigabytes(mb: cap.committedMb)) / \(formatGigabytes(mb: cap.totalMemoryMb))")
            .font(Theme.mono())
            .fixedSize()
        }
      }
      if let cpu = metrics.totalCpu {
        HStack(spacing: 6) {
          Text("CPU").foregroundStyle(Theme.secondary)
          Text(formatPercent(cpu)).font(Theme.mono())
        }
        .help("CPU of every live workspace's processes, simulators and emulators, as a percent of one core")
      }
      if metrics.totalResident > 0 {
        HStack(spacing: 6) {
          Text("RAM").foregroundStyle(Theme.secondary)
          Text(formatMemory(metrics.totalResident)).font(Theme.mono())
        }
        .help("Resident memory of every live workspace's processes, simulators and emulators")
      }
      if let lowest = metrics.volumes.min(by: { $0.availableBytes < $1.availableBytes }) {
        Button { showsDisk.toggle() } label: {
          HStack(spacing: 6) {
            Image(systemName: "internaldrive").foregroundStyle(Theme.secondary)
            Text("\(formatDisk(lowest.availableBytes)) free").font(Theme.mono())
              .foregroundStyle(lowest.availableBytes < 20_000_000_000 ? Theme.warn : Theme.text)
            if let reclaimable = metrics.reclaimable, reclaimable.bytes > 0 {
              Text("\u{00B7} \(formatDisk(reclaimable.bytes)) reclaimable").foregroundStyle(Theme.primary)
            }
          }
        }
        .buttonStyle(.plain)
        .help("Free space on the fullest volume holding the repositories, Stim home or simulators, purgeable space included")
        .popover(isPresented: $showsDisk, arrowEdge: .bottom) {
          DiskPopover(volumes: metrics.volumes, reclaimable: metrics.reclaimable)
        }
      }
      if let at = store.updatedAt {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          Text("\(max(0, Int(context.date.timeIntervalSince(at))))s ago")
            .font(Theme.mono())
            .foregroundStyle(Theme.tertiary)
        }
      }
    }
    .font(Theme.body(12))
    .padding(.horizontal, 10)
  }
}

struct DiskPopover: View {
  var volumes: [DiskVolume]
  var reclaimable: GcReport.Reclaimable?

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      SectionLabel(title: "Disk")
      ForEach(volumes) { volume in
        VStack(alignment: .leading, spacing: 6) {
          HStack {
            Text(volume.name).font(Theme.body(12, weight: .semibold))
            Spacer()
            Text("\(formatDisk(volume.availableBytes)) free of \(formatDisk(volume.totalBytes))")
              .font(Theme.mono())
              .foregroundStyle(Theme.secondary)
          }
          ProgressView(value: 1 - Double(volume.availableBytes) / Double(max(1, volume.totalBytes)))
            .tint(volume.availableBytes < 20_000_000_000 ? Theme.warn : Theme.lavender)
          Text(volume.holds.joined(separator: ", ")).foregroundStyle(Theme.tertiary)
        }
      }
      Rectangle().fill(Theme.border).frame(height: 1)
      SectionLabel(title: "Reclaimable")
      if let reclaimable {
        if reclaimable.entries == 0 {
          Text("stim gc reports nothing to reclaim.").foregroundStyle(Theme.secondary)
        } else {
          Text(formatDisk(reclaimable.bytes)).font(Theme.heading(20)).foregroundStyle(Theme.primary)
          Text(
            "\(reclaimable.entries) \(reclaimable.entries == 1 ? "entry" : "entries")"
              + (reclaimable.unsized > 0 ? ", \(reclaimable.unsized) of unknown size" : "")
          )
          .foregroundStyle(Theme.secondary)
        }
        CommandText(command: "stim gc")
      } else {
        Text("Needs a stim version with gc --json.").foregroundStyle(Theme.secondary)
      }
    }
    .font(Theme.body(12))
    .foregroundStyle(Theme.text)
    .padding(18)
    .frame(width: 340)
    .background(Theme.sidebar)
  }
}
