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
  var machine: MachineUsage?
  var reportsBundles: Bool
  var history: OwnerHistory
  var inspector: InspectorPresentation
  @Binding var inspectorWidth: CGFloat
  @Binding var focusedID: String?
  @Binding var tab: DetailTab
  @Binding var logQuery: LogQuery
  var openLogs: () -> Void
  @State private var stats: ProjectStats?
  @State private var contentWidth: CGFloat = 0
  @State private var takenOver: Set<String> = []
  @State private var resizeStartWidth: CGFloat?
  @State private var width: CGFloat = 0

  static let inspectorWidth: CGFloat = 320
  static let widthWithInspector: CGFloat = 760
  static let minimumInspectorWidth: CGFloat = 280
  static let maximumInspectorWidth: CGFloat = 420
  private static let minimumContentWidth: CGFloat = 440
  static let wideContentWidth: CGFloat = 820

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
      WorkspaceSummary(
        cli: cli, env: env, machine: machine, reportsBundles: reportsBundles, history: history, usage: usage,
        wide: contentWidth >= Self.wideContentWidth,
        openLogs: { errors in
          if errors {
            openLogs()
          } else {
            logQuery.errorsOnly = false
            tab = .logs
          }
        }
      )
      .padding(.horizontal, Space.xxl)
      .padding(.top, Space.lg)
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
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { contentWidth = $0 }
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
    Inspector(env: env, stats: stats)
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
    GeometryReader { geo in
      deviceStack(devices: devices, focused: focused, screenHeight: min(640, max(260, geo.size.height - 190)))
    }
  }

  private func deviceStack(devices: [DeviceRef], focused: DeviceRef?, screenHeight: CGFloat) -> some View {
    VStack(spacing: Space.xl) {
      devicePicker(devices: devices, focused: focused)
      if let focused {
        if let target = replayTarget(focused) {
          ReplayHost(target: target) { replay in
            ReplayingTile(replay: replay) { replaying in
              focusedTile(focused, replay: replay, replaying: replaying, screenHeight: screenHeight)
            }
          }
          .id(focused.id)
        } else {
          focusedTile(focused, replay: nil, replaying: false, screenHeight: screenHeight)
        }
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

extension WorkspaceDetail {
  /// Physical and remote devices have no replay, as on the phone.
  private func replayTarget(_ device: DeviceRef) -> ReplayTarget? {
    switch device {
    case .remote: return nil
    case _ where device.isPhysical: return nil
    default: return ReplayTarget(workspace: env.path, platform: device.platform, slot: device.slot)
    }
  }

  private func focusedTile(_ focused: DeviceRef, replay: ReplayController?, replaying: Bool, screenHeight: CGFloat)
    -> some View
  {
    DeviceTile(
      device: focused, screenHeight: screenHeight,
      interactive: focused.isRunning && takenOver.contains(focused.id) && !replaying, workspace: env.path,
      workspaceTitle: env.names.title,
      build: env.runningBuild(for: focused),
      takenOver: takenOver.contains(focused.id) && !replaying,
      onToggleTakeOver: focused.isInteractive
        ? {
          if takenOver.contains(focused.id) { takenOver.remove(focused.id) } else { takenOver.insert(focused.id) }
        } : nil,
      replay: replay, replaying: replaying, replayOff: env.replayOff,
      onReplaySeek: { takenOver.remove(focused.id) })
  }
}

/// Re-renders its content as the replay starts, stops or moves.
private struct ReplayingTile<Content: View>: View {
  @ObservedObject var replay: ReplayController
  @ViewBuilder var content: (Bool) -> Content

  var body: some View { content(replay.replay != nil) }
}

struct Inspector: View {
  var env: Workspace
  var stats: ProjectStats?
  @EnvironmentObject private var actions: ActionCenter
  @State private var confirmingStopDevice: DeviceRef?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxxl) {
        if let agents = env.agents, !agents.isEmpty {
          AgentSessionsSection(agents: agents)
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
            } else if device.pageFailed {
              Text("Page failed").foregroundStyle(Palette.warning).lineLimit(1).layoutPriority(1)
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
    let isWeb = device.platform == "web"
    Button(isWeb ? "Close" : "Stop") {
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
        : isWeb
          ? "stim stop --slot web: closes Stim's Chrome and keeps its profile, Metro and every device"
          : "stim stop --slot \(device.slot): stops every device in this slot, keeping the shared server and other slots running"
    )
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
