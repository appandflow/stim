import StimKit
import SwiftUI

enum DetailTab: Hashable {
  case device
  case logs
}

struct WorkspaceDetail: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var usage: UsageHistory?
  var inspector: InspectorPresentation
  @Binding var inspectorWidth: CGFloat
  @Binding var focusedID: String?
  @Binding var tab: DetailTab
  @Binding var logQuery: LogQuery
  var openLogs: () -> Void
  @State private var stats: ProjectStats?
  @State private var takenOver: Set<String> = []
  @State private var resizeStartWidth: CGFloat?
  @State private var width: CGFloat = 0

  static let inspectorWidth: CGFloat = 320
  static let widthWithInspector: CGFloat = 760
  static let minimumInspectorWidth: CGFloat = 280
  static let maximumInspectorWidth: CGFloat = 420
  private static let minimumContentWidth: CGFloat = 440

  var body: some View {
    let devices = env.orderedDevices
    let focused = devices.first { $0.id == focusedID } ?? devices.first
    HStack(spacing: 0) {
      content(devices: devices, focused: focused)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      if inspector == .column {
        Rectangle().fill(Theme.border).frame(width: 1)
          .overlay { resizeHandle }
        inspectorPanel
          .frame(width: Self.clampedInspectorWidth(inspectorWidth, detailWidth: width))
          .background(Theme.sidebar)
      }
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    .overlay(alignment: .trailing) {
      if inspector == .overlay {
        inspectorPanel
          .frame(width: Self.inspectorWidth)
          .background(Theme.sidebar, ignoresSafeAreaEdges: [])
          .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 1) }
          .shadow(color: .black.opacity(0.25), radius: 16)
      }
    }
    .navigationTitle(env.names.title)
    .task(id: env.path) {
      let path = env.path
      let cli = await cli.value
      stats = await Task.detached { try? cli.stats(workspace: path) }.value
    }
  }

  private func content(devices: [DeviceRef], focused: DeviceRef?) -> some View {
    VStack(spacing: 0) {
      Picker("View", selection: $tab) {
        Text("Device").tag(DetailTab.device)
        Text("Logs").tag(DetailTab.logs)
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .fixedSize()
      .padding(.vertical, 12)
      Rectangle().fill(Theme.border).frame(height: 1)
      switch tab {
      case .device: deviceView(devices: devices, focused: focused)
      case .logs: LogsView(cli: cli, env: env, query: $logQuery)
      }
    }
  }

  static func clampedInspectorWidth(_ proposed: CGFloat, detailWidth: CGFloat) -> CGFloat {
    let maximum = min(maximumInspectorWidth, detailWidth - 1 - minimumContentWidth)
    return max(minimumInspectorWidth, min(maximum, proposed))
  }

  private var resizeHandle: some View {
    Color.clear
      .frame(width: 8)
      .contentShape(Rectangle())
      .onHover { inside in
        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
      }
      .gesture(
        DragGesture(minimumDistance: 1, coordinateSpace: .global)
          .onChanged { drag in
            let start = resizeStartWidth ?? Self.clampedInspectorWidth(inspectorWidth, detailWidth: width)
            resizeStartWidth = start
            inspectorWidth = Self.clampedInspectorWidth(start - drag.translation.width, detailWidth: width)
          }
          .onEnded { _ in resizeStartWidth = nil })
  }

  private var inspectorPanel: some View {
    Inspector(env: env, usage: usage, stats: stats, openLogs: openLogs)
      .frame(maxHeight: .infinity)
  }

  @ViewBuilder
  private func devicePicker(devices: [DeviceRef], focused: DeviceRef?) -> some View {
    let segments = devices.filter { $0.isRunning || $0.id == focused?.id }
    let stopped = devices.filter { !$0.isRunning }
    if segments.count > 1 || !stopped.isEmpty {
      HStack(spacing: 8) {
        if segments.count > 1 {
          HStack(spacing: 2) {
            ForEach(segments) { device in
              Button { focusedID = device.id } label: {
                HStack(spacing: 6) {
                  StatusDot(color: stateColor(device), filled: device.isRunning)
                  Text(device.label(among: devices)).lineLimit(1)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 6).fill(device.id == focused?.id ? Theme.surface : .clear))
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .help(device.detail.map { "\(device.label) \u{00B7} \($0) \u{00B7} \(device.state)" } ?? device.state)
            }
          }
          .padding(2)
          .background(RoundedRectangle(cornerRadius: 8).fill(Theme.border))
        }
        if !stopped.isEmpty {
          Menu {
            ForEach(stopped) { device in
              Button("\(device.label(among: devices)) \u{00B7} \(device.state)") { focusedID = device.id }
            }
          } label: {
            Text("+\(stopped.count) stopped")
          }
          .menuStyle(.button)
          .menuIndicator(.hidden)
          .buttonStyle(.stim())
          .fixedSize()
          .help("Devices of this workspace that are not running")
        }
      }
      .font(Theme.body(12))
    }
  }

  private func stateColor(_ device: DeviceRef) -> Color {
    if device.state == "Booting" || env.runningBuild(for: device) != nil { return Theme.warn }
    return device.isRunning ? Theme.live : Theme.tertiary
  }

  private func deviceView(devices: [DeviceRef], focused: DeviceRef?) -> some View {
    VStack(spacing: 16) {
      devicePicker(devices: devices, focused: focused)
      if let focused {
        DeviceTile(
          device: focused, screenHeight: 640,
          interactive: focused.isRunning && takenOver.contains(focused.id), workspace: env.path,
          build: env.runningBuild(for: focused),
          takenOver: takenOver.contains(focused.id),
          onToggleTakeOver: focused.isInteractive
            ? {
              if takenOver.contains(focused.id) { takenOver.remove(focused.id) } else { takenOver.insert(focused.id) }
            } : nil)
        AgentFeed(cli: cli, workspace: env.path, device: focused)
          .id(focused.id)
          .frame(maxWidth: 520)
      } else {
        EmptyState(title: "No devices", message: "This workspace has no recorded simulator or emulator.")
      }
      Spacer(minLength: 0)
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct Inspector: View {
  var env: Workspace
  var usage: UsageHistory?
  var stats: ProjectStats?
  var openLogs: () -> Void
  @EnvironmentObject private var actions: ActionCenter
  @State private var removal: WorktreeRemoval?
  @State private var confirmingStop = false
  @State private var confirmingStopDevice: DeviceRef?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        statusCard

        if let usage {
          VStack(alignment: .leading, spacing: 8) {
            SectionLabel(title: "Resources \u{00B7} \(usage.latest.processCount) processes")
            ViewThatFits(in: .horizontal) {
              HStack(alignment: .top, spacing: 10) { usageCards(usage) }
              VStack(spacing: 10) { usageCards(usage) }
            }
          }
        }

        VStack(alignment: .leading, spacing: 8) {
          SectionLabel(title: "Devices")
          ForEach(env.orderedDevices) { device in
            HStack(spacing: 8) {
              StatusDot(color: device.isRunning ? Theme.live : Theme.tertiary, filled: device.isRunning)
              Text(device.label(among: env.devices)).font(Theme.body(12, weight: .semibold)).lineLimit(1)
              if let detail = device.detail {
                Text(detail).foregroundStyle(Theme.secondary).lineLimit(1).layoutPriority(1)
              }
              Spacer()
              Text(device.state).foregroundStyle(Theme.tertiary).lineLimit(1)
              if device.isRunning {
                deviceStopButton(device)
              }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.surface))
          }
        }

        BuildCacheSection(env: env)
          .id(env.path)

        if let project = stats?.project, project.ios != nil || project.android != nil {
          VStack(alignment: .leading, spacing: 8) {
            SectionLabel(title: "Build cache \u{00B7} project")
            ViewThatFits(in: .horizontal) {
              HStack(alignment: .top, spacing: 10) { statCards(project) }
              VStack(spacing: 10) { statCards(project) }
            }
          }
        }

        if !env.warnings.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            SectionLabel(title: "Warnings")
            ForEach(env.warnings, id: \.self) { warning in
              Label(abbreviatingHome(warning), systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.warn)
                .textSelection(.enabled)
            }
          }
        }
      }
      .font(Theme.body(12))
      .padding(20)
    }
    .confirmationDialog(
      "Stop this remote session?",
      isPresented: Binding(get: { confirmingStopDevice != nil }, set: { if !$0 { confirmingStopDevice = nil } }),
      titleVisibility: .visible,
      presenting: confirmingStopDevice
    ) { device in
      Button("Run stim stop", role: .destructive) {
        actions.run("Stop \(device.slot)", stopCommand(for: device, cwd: env.path))
      }
    } message: { _ in
      Text(
        "stim stop ends the billable remote session and halts the workspace's dev server and devices. The session cannot be resumed."
      )
    }
  }

  @ViewBuilder
  private func deviceStopButton(_ device: DeviceRef) -> some View {
    let isRemote = { if case .remote = device { return true } else { return false } }()
    Button("Stop") {
      if isRemote {
        confirmingStopDevice = device
      } else {
        actions.run("Stop \(device.slot)", stopCommand(for: device, cwd: env.path))
      }
    }
    .buttonStyle(.stim(.destructive))
    .disabled(actions.active(for: env.path) != nil)
    .help(
      isRemote
        ? "stim stop: ends the billable remote session with the rest of the workspace"
        : "stim stop --slot \(device.slot): stops every device in this slot, keeping the shared server and other slots running"
    )
  }

  private var statusCard: some View {
    let errors = env.logs?.errorsSinceMarker ?? 0
    let metroHealthy = env.metro?.running == true && env.supervisor?.healthy != false
    return VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        if let branch = env.worktree?.branch {
          Text(branch).font(Theme.body(12, weight: .semibold)).lineLimit(1)
        }
        if let folder = pathInCheckout(env.path, worktree: env.worktree?.path) {
          Text(folder).font(Theme.mono()).foregroundStyle(Theme.secondary).lineLimit(1).truncationMode(.middle)
        }
        Spacer(minLength: 0)
        actionsMenu
      }
      FlowLayout(spacing: 6) {
        if let metro = env.metro {
          Chip(tint: metroHealthy ? Theme.live : Theme.error) {
            Text("Metro :\(String(metro.port)) \u{00B7} \(metro.running ? (metroHealthy ? "healthy" : "unhealthy") : "stopped")")
          }
          .help(env.supervisor.map { "\($0.mode ?? "supervisor") \u{00B7} \($0.healthy == true ? "healthy" : "unhealthy")" } ?? "")
        }
        GitIndicator(git: env.worktree?.git, chips: true).help(env.worktree?.git?.summary ?? "")
        if let mb = env.memoryMb, mb > 0 {
          Chip { Text(formatGigabytes(mb: mb)) }.help("Committed memory estimate from stim status")
        }
        if env.logs != nil {
          Button(action: openLogs) {
            Chip(tint: errors > 0 ? Theme.error : nil) { Text(errors == 1 ? "1 error" : "\(errors) errors") }
          }
          .buttonStyle(.plain)
          .help("Open the logs filtered to errors")
        }
      }
      if let active = actions.active(for: env.path) {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text(active.title).lineLimit(1)
          Spacer()
          Button("Show output") { actions.presented = active }
        }
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border))
    .controlSize(.small)
  }

  private var actionsMenu: some View {
    let busy = actions.active(for: env.path) != nil
    return Menu {
      WorkspaceActionsMenu(
        kind: .workspace(metroRunning: env.metro?.running == true),
        path: env.path,
        busy: busy,
        removalAllowed: worktreeRemovalAllowed(git: env.worktree?.git),
        onShowLastOutput: actions.latest(for: env.path).map { last in { actions.presented = last } },
        onReload: { actions.run("Reload \(env.names.title)", StimCommand(["reload"], cwd: env.path)) },
        onStartDevServer: { actions.run("Start \(env.names.title)", StimCommand(["start"], cwd: env.path)) },
        onStopDevServer: {
          if env.remoteDevices?.isEmpty == false {
            confirmingStop = true
          } else {
            stop()
          }
        },
        onShowLogs: openLogs,
        onRemoveWorktree: { requestRemoval() })
    } label: {
      Image(systemName: "ellipsis")
    }
    .menuStyle(.button)
    .menuIndicator(.hidden)
    .buttonStyle(.borderless)
    .fixedSize()
    .help("Workspace actions")
    .confirmationDialog("Stop this workspace?", isPresented: $confirmingStop, titleVisibility: .visible) {
      Button("Run stim stop", role: .destructive) { stop() }
    } message: {
      Text("This also ends the workspace's billable EAS Simulator session.")
    }
    .confirmationDialog(
      "Remove this worktree?",
      isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } }),
      titleVisibility: .visible,
      presenting: removal
    ) { _ in
      Button("Run stim worktree remove", role: .destructive) {
        actions.run("Remove \(env.names.title)", StimCommand(["worktree", "remove"], cwd: env.path))
      }
    } message: { removal in
      Text(worktreeRemovalMessage(path: env.path, branch: removal.branch))
    }
  }

  private func stop() {
    actions.run("Stop \(env.names.title)", StimCommand(["stop"], cwd: env.path))
  }

  private func requestRemoval() {
    resolveRemovalBranch(at: env.path) { removal = WorktreeRemoval(branch: $0) }
  }

  @ViewBuilder private func usageCards(_ usage: UsageHistory) -> some View {
    usageCard("cpu", "CPU", usage.latest.cpuPercent.map(formatPercent) ?? "--", values: usage.cpu, minimumPeak: 100)
    usageCard(
      "memorychip", "Resident memory", formatMemory(usage.latest.residentBytes), values: usage.resident,
      minimumPeak: 1_073_741_824)
  }

  @ViewBuilder private func statCards(_ project: ProjectStats.Scope) -> some View {
    if let ios = project.ios { statCard("iOS", ios) }
    if let android = project.android { statCard("Android", android) }
  }

  private func usageCard(_ icon: String, _ title: String, _ value: String, values: [Double], minimumPeak: Double)
    -> some View
  {
    VStack(alignment: .leading, spacing: 6) {
      Label(title, systemImage: icon).foregroundStyle(Theme.secondary)
      Text(value).font(Theme.heading(22))
      Sparkline(values: values, minimumPeak: minimumPeak).frame(height: 32)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
  }

  private func statCard(_ title: String, _ platform: ProjectStats.Platform) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).foregroundStyle(Theme.secondary)
      Text("\(Int((platform.hitRate * 100).rounded()))%").font(Theme.heading(22))
      ProgressView(value: platform.hitRate).tint(Theme.lavender)
      Text("\(platform.hits) hits \u{00B7} \(platform.misses) misses").foregroundStyle(Theme.secondary)
      if let cold = platform.lastColdBuildMs {
        Text("Last cold \(formatDuration(ms: cold))").foregroundStyle(Theme.secondary)
      }
      if let saved = platform.timeSavedMs {
        Text("Saved \(formatDuration(ms: saved))").foregroundStyle(Theme.primary)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(Theme.surface))
  }
}
