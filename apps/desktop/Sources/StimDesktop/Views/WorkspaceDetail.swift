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
        Rectangle().fill(Palette.border).frame(width: 1)
          .overlay { resizeHandle }
        inspectorPanel
          .frame(width: Self.clampedInspectorWidth(inspectorWidth, detailWidth: width))
          .background(Palette.sidebar)
          .toolbarBackdrop(Palette.sidebar)
      }
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    .overlay(alignment: .trailing) {
      if inspector == .overlay {
        inspectorPanel
          .frame(width: Self.inspectorWidth)
          .background(Palette.sidebar, ignoresSafeAreaEdges: [])
          .clipped()
          .overlay(alignment: .leading) { Rectangle().fill(Palette.border).frame(width: 1) }
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
      .padding(.vertical, Space.lg)
      Rectangle().fill(Palette.border).frame(height: 1)
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
      HStack(spacing: Space.md) {
        if segments.count > 1 {
          HStack(spacing: Space.xxs) {
            ForEach(segments) { device in
              Button { focusedID = device.id } label: {
                HStack(spacing: Space.sm) {
                  StatusDot(color: stateColor(device), filled: device.isRunning)
                  Text(device.label(among: devices)).lineLimit(1)
                }
                .padding(.horizontal, Space.md)
                .padding(.vertical, Space.xs)
                .background(RoundedRectangle(cornerRadius: Radius.chip).fill(device.id == focused?.id ? Palette.surface : .clear))
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .help(device.detail.map { "\(device.label) \u{00B7} \($0) \u{00B7} \(device.state)" } ?? device.state)
            }
          }
          .padding(Space.xxs)
          .background(RoundedRectangle(cornerRadius: Radius.chip).fill(Palette.border))
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
      .font(.stim(.callout))
    }
  }

  private func stateColor(_ device: DeviceRef) -> Color {
    if device.state == "Booting" || env.runningBuild(for: device) != nil { return Palette.warning }
    return device.isRunning ? Palette.success : Palette.tertiary
  }

  private func deviceView(devices: [DeviceRef], focused: DeviceRef?) -> some View {
    VStack(spacing: Space.xl) {
      devicePicker(devices: devices, focused: focused)
      if let focused {
        DeviceTile(
          device: focused, screenHeight: 640,
          interactive: focused.isRunning && takenOver.contains(focused.id), workspace: env.path,
          workspaceTitle: env.names.title,
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
    .padding(Space.xxxl)
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
      VStack(alignment: .leading, spacing: Space.xxxl) {
        statusCard

        if let usage {
          VStack(alignment: .leading, spacing: Space.md) {
            SectionLabel(title: "Resources \u{00B7} " + countLabel(usage.latest.processCount, "process", plural: "processes"))
            ViewThatFits(in: .horizontal) {
              HStack(alignment: .top, spacing: Space.md) { usageCards(usage) }
              VStack(spacing: Space.md) { usageCards(usage) }
            }
          }
        }

        ListSection("Devices", env.orderedDevices, style: .separated) { device in
          ListRow(compact: true) {
            StatusDot(color: device.isRunning ? Palette.success : Palette.tertiary, filled: device.isRunning)
            Text(device.label(among: env.devices)).font(.stim(.callout, weight: .semibold)).lineLimit(1)
              .layoutPriority(1)
            if let detail = device.detail {
              Text(detail).foregroundStyle(Palette.secondary).lineLimit(1)
            }
            Spacer()
            if device.appStopped {
              Text("App stopped").foregroundStyle(Palette.warning).lineLimit(1).layoutPriority(1)
            } else {
              Text(device.state).foregroundStyle(Palette.tertiary).lineLimit(1)
            }
            if device.isRunning {
              deviceStopButton(device)
            }
          }
        }

        BuildCacheSection(env: env)
          .id(env.path)

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
    .fixedSize()
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
    return VStack(alignment: .leading, spacing: Space.md) {
      HStack(spacing: Space.md) {
        if let branch = env.worktree?.branch {
          Text(branch).font(.stim(.callout, weight: .semibold)).lineLimit(1)
        }
        if let folder = pathInCheckout(env.path, worktree: env.worktree?.path) {
          Text(folder).font(.stim(.caption, mono: true)).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle)
        }
        Spacer(minLength: 0)
        actionsMenu
      }
      FlowLayout(spacing: Space.sm) {
        if let metro = env.metro {
          Pill(tone: metroHealthy ? .success : .error) {
            Text("Metro :\(String(metro.port)) \u{00B7} \(metro.running ? (metroHealthy ? "healthy" : "unhealthy") : "stopped")")
          }
          .help(env.supervisor.map { "\($0.mode ?? "supervisor") \u{00B7} \($0.healthy == true ? "healthy" : "unhealthy")" } ?? "")
        }
        GitIndicator(git: env.worktree?.git, chips: true)
        if let mb = env.memoryMb, mb > 0 {
          MemoryEstimatePill(mb: mb)
        }
        if env.logs != nil {
          Button(action: openLogs) {
            Pill(tone: errors > 0 ? .error : .neutral) { Text(countLabel(errors, "error")) }
          }
          .buttonStyle(.plain)
          .help("Open the logs filtered to errors")
        }
      }
      if let active = actions.active(for: env.path) {
        HStack(spacing: Space.md) {
          ProgressView().controlSize(.small)
          Text(active.title).lineLimit(1)
          Spacer()
          Button("Show output") { actions.presented = active }
        }
      }
    }
    .padding(Space.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
    .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Palette.border))
    .controlSize(.small)
  }

  private var actionsMenu: some View {
    let busy = actions.active(for: env.path) != nil
    return Menu {
      WorkspaceActionsMenu(
        kind: .workspace(metroRunning: env.metro?.running == true, platforms: env.runPlatforms),
        path: env.path,
        busy: busy,
        removalAllowed: worktreeRemovalAllowed(git: env.worktree?.git),
        building: env.build?.isRunning == true,
        reloadAllowed: env.canReload,
        onShowLastOutput: actions.latest(for: env.path).map { last in { actions.presented = last } },
        onRun: { platform in actions.runApp(env, platform: platform) },
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
    VStack(alignment: .leading, spacing: Space.sm) {
      Label(title, systemImage: icon).foregroundStyle(Palette.secondary)
      Text(value).font(.stim(.title))
      Sparkline(values: values, minimumPeak: minimumPeak).frame(height: 32)
    }
    .padding(Space.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
  }

  private func statCard(_ title: String, _ platform: ProjectStats.Platform) -> some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Text(title).foregroundStyle(Palette.secondary)
      Text("\(Int((platform.hitRate * 100).rounded()))%").font(.stim(.title))
      ProgressView(value: platform.hitRate).tint(Palette.accent)
      Text("\(countLabel(platform.hits, "hit")) \u{00B7} \(countLabel(platform.misses, "miss", plural: "misses"))").foregroundStyle(Palette.secondary)
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
