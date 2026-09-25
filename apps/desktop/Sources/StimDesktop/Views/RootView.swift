import StimKit
import SwiftUI

enum SidebarItem: Hashable {
  case wall
  case project(Project)
  case environment(String)
  case attention
}

struct RootView: View {
  @ObservedObject private var store: StatusStore
  @StateObject private var metrics: MetricsStore
  @StateObject private var actions: ActionCenter
  @State private var selection: SidebarItem? = .wall
  @State private var restoredProject = false
  @AppStorage(AppPreferences.Key.defaultView) private var defaultView = DefaultView.allDevices
  @AppStorage(AppPreferences.Key.lastProjectPath) private var lastProjectPath = ""
  @State private var projectFilter: Project?
  @State private var focusedDeviceID: String?
  @State private var detailTab = DetailTab.device
  @State private var logQuery = LogQuery()
  @ObservedObject private var openRequests = OpenRequests.shared

  private let cli: Task<StimCLI, Never>

  init(cli: Task<StimCLI, Never>, store: StatusStore) {
    self.cli = cli
    self.store = store
    _metrics = StateObject(wrappedValue: MetricsStore(status: store, cli: cli))
    _actions = StateObject(wrappedValue: ActionCenter(cli: cli))
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
    .environmentObject(actions)
    .sheet(item: $actions.presented) { run in
      ActivitySheet(run: run).environmentObject(actions)
    }
    .onAppear {
      actions.onFinish = store.refresh
      store.start()
      metrics.start()
    }
    .onReceive(openRequests.$simulatorUdid) { udid in showSimulator(udid, in: store.payload) }
    .onReceive(store.$payload) { payload in
      showSimulator(openRequests.simulatorUdid, in: payload)
      restoreLastProject()
    }
    .onReceive(store.$projects) { _ in restoreLastProject() }
    .onReceive(openRequests.$workspacePath) { path in
      guard let path else { return }
      openRequests.workspacePath = nil
      selection = .environment(path)
    }
    .onChange(of: selection) { _, item in
      restoredProject = true
      switch item {
      case .wall:
        projectFilter = nil
        openRequests.selectedWorkspace = nil
      case .project(let project):
        projectFilter = project
        lastProjectPath = project.root
        openRequests.selectedWorkspace = store.environments(in: project).first?.path
      case .environment(let path):
        openRequests.selectedWorkspace = path
      default: break
      }
    }
  }

  private func restoreLastProject() {
    guard !restoredProject, defaultView == .lastProject, !lastProjectPath.isEmpty, selection == .wall else { return }
    guard let entry = store.projectList.first(where: { $0.project.root == lastProjectPath }) else { return }
    restoredProject = true
    selection = .project(entry.project)
  }

  /// `@Published` emits before the property changes, so both values arrive as arguments.
  private func showSimulator(_ udid: String?, in payload: StatusPayload?) {
    guard let udid, let owner = payload?.owner(ofSimulator: udid) else { return }
    openRequests.simulatorUdid = nil
    selection = .environment(owner.workspace.path)
    focusedDeviceID = owner.device.id
    detailTab = .device
  }

  private func openErrors(_ path: String) {
    selection = .environment(path)
    detailTab = .logs
    logQuery.errorsOnly = true
  }

  @ViewBuilder private var detail: some View {
    switch selection {
    case .environment(let path):
      if let env = store.payload?.environments.first(where: { $0.path == path }) {
        WorkspaceDetail(
          cli: cli, env: env, usage: metrics.usage[env.path], focusedID: $focusedDeviceID, tab: $detailTab,
          logQuery: $logQuery, openLogs: { openErrors(env.path) })
      } else {
        EmptyState(title: "Workspace gone", message: "stim status no longer reports this workspace.")
      }
    case .attention:
      AttentionView(store: store)
    default:
      WallView(store: store, metrics: metrics, project: projectFilter, selection: $selection, openLogs: openErrors)
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
      if store.watching {
        Text("live")
          .font(Theme.mono())
          .foregroundStyle(Theme.tertiary)
          .help("stim status --watch reports each change as it happens")
      } else if let at = store.updatedAt {
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
