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
  @State private var takenOver: String?
  @State private var logsResizeStart: CGFloat?
  @AppStorage(AppPreferences.Key.logsPaneWidth) private var logsWidth = Double(WorkspaceDetail.defaultLogsWidth)
  @AppStorage(AppPreferences.Key.showsLogsPane) private var showsLogsPane = true
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

  private var wide: Bool { contentWidth >= Self.wideContentWidth }

  private func content(devices: [DeviceRef], focused: DeviceRef?) -> some View {
    VStack(spacing: 0) {
      WorkspaceSummary(
        cli: cli, env: env, machine: machine, reportsBundles: reportsBundles, history: history, usage: usage,
        wide: wide,
        openLogs: { errors in
          if errors {
            openLogs()
          } else {
            logQuery.errorsOnly = false
            tab = .logs
          }
          showsLogsPane = true
        }
      )
      .padding(.horizontal, Space.xxl)
      .padding(.top, Space.lg)
      .padding(.bottom, Space.lg)
      Rectangle().fill(Palette.border).frame(height: 1)
      if !wide {
        Picker("View", selection: $tab) {
          Text("Devices").tag(DetailTab.device)
          Text("Logs").tag(DetailTab.logs)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .padding(.vertical, Space.md)
        .help("Show the workspace's devices or its logs. A wider window shows both.")
        Rectangle().fill(Palette.border).frame(height: 1)
      }
      HStack(spacing: 0) {
        if wide || tab == .device {
          VStack(spacing: 0) {
            if wide { canvasBar(devices: devices) }
            canvas(devices: devices, focused: focused)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          LogsView(cli: cli, env: env, query: $logQuery)
        }
        if wide, showsLogsPane {
          Rectangle().fill(Palette.border).frame(width: 1).overlay { logsResizeHandle }
          LogsView(cli: cli, env: env, query: $logQuery)
            .frame(width: Self.clampedLogsWidth(logsWidth, contentWidth: contentWidth))
        }
      }
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { contentWidth = $0 }
  }

  private func canvasBar(devices: [DeviceRef]) -> some View {
    HStack(spacing: Space.md) {
      SectionLabel(title: devices.isEmpty ? "Devices" : "Devices \u{00B7} \(devices.count)")
      Spacer()
      Button {
        showsLogsPane.toggle()
      } label: {
        Label(showsLogsPane ? "Hide logs" : "Show logs", systemImage: "text.alignleft")
      }
      .buttonStyle(.stim(.plain))
      .fixedSize()
      .help(showsLogsPane ? "Hide the logs pane beside the devices" : "Show the workspace's logs beside the devices")
    }
    .padding(.horizontal, Space.xxl)
    .padding(.vertical, Space.sm)
  }

  static let minimumLogsWidth: CGFloat = 320
  static let defaultLogsWidth: CGFloat = 420
  private static let minimumCanvasWidth: CGFloat = 360

  static func clampedLogsWidth(_ proposed: CGFloat, contentWidth: CGFloat) -> CGFloat {
    max(minimumLogsWidth, min(contentWidth - 1 - minimumCanvasWidth, proposed))
  }

  private var logsResizeHandle: some View {
    Color.clear
      .frame(width: 8)
      .contentShape(Rectangle())
      .onHover { inside in
        if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
      }
      .gesture(
        DragGesture(minimumDistance: 1, coordinateSpace: .global)
          .onChanged { drag in
            let start = logsResizeStart ?? Self.clampedLogsWidth(logsWidth, contentWidth: contentWidth)
            logsResizeStart = start
            logsWidth = Self.clampedLogsWidth(start - drag.translation.width, contentWidth: contentWidth)
          }
          .onEnded { _ in logsResizeStart = nil })
      .help("Drag to resize the logs pane")
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

  private func canvas(devices: [DeviceRef], focused: DeviceRef?) -> some View {
    GeometryReader { geo in
      ScrollView {
        if devices.isEmpty {
          emptyCanvas.frame(maxWidth: .infinity).padding(Space.xxxl)
        } else {
          let screenHeight = canvasScreenHeight(
            aspects: devices.map(\.canvasAspect),
            canvas: CGSize(width: geo.size.width - Space.xxl * 2, height: geo.size.height - Space.xxl * 2),
            spacing: Space.xl, chrome: 190, padding: 24, minimumWidth: DeviceTile.minimumWidth, minimum: 260,
            maximum: 640)
          FlowLayout(spacing: Space.xl, lineSpacing: Space.xl, topAligned: true) {
            ForEach(devices) { device in
              tile(device, focused: device.id == focused?.id, screenHeight: screenHeight)
            }
          }
          .padding(Space.xxl)
        }
      }
    }
  }

  private var emptyCanvas: some View {
    TimelineView(.periodic(from: .now, by: 30)) { context in
      emptyCanvas(stage: env.stage(now: context.date))
    }
  }

  @ViewBuilder private func emptyCanvas(stage: WorkspaceStage) -> some View {
    if stage.label == .warming {
      VStack(spacing: Space.sm) {
        ProgressView().controlSize(.small)
        Text("Warming the workspace").font(.stim(.body)).foregroundStyle(Palette.secondary)
        if let subtitle = stage.subtitle {
          Text(subtitle).font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
        }
      }
      .frame(maxWidth: 420, minHeight: 140)
      .frame(maxWidth: .infinity)
      .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    } else {
      EmptyState(
        title: "No devices",
        message: stage.label == .stopped
          ? "Nothing is running. Ask your agent to run the app."
          : "No device in this workspace yet. Run stim ios or stim android.",
        showsPrompts: true
      )
      .id(env.path)
    }
  }

  @ViewBuilder private func tile(_ device: DeviceRef, focused: Bool, screenHeight: CGFloat) -> some View {
    Group {
      if let target = replayTarget(device) {
        ReplayHost(target: target) { replay in
          ReplayingTile(replay: replay) { replaying in
            deviceTile(device, focused: focused, screenHeight: screenHeight, replay: replay, replaying: replaying)
          }
        }
      } else {
        deviceTile(device, focused: focused, screenHeight: screenHeight, replay: nil, replaying: false)
      }
    }
    .simultaneousGesture(TapGesture().onEnded { focusedID = device.id })
  }

  /// Physical and remote devices have no replay, as on the phone.
  private func replayTarget(_ device: DeviceRef) -> ReplayTarget? {
    switch device {
    case .remote: return nil
    case _ where device.isPhysical: return nil
    default: return ReplayTarget(workspace: env.path, platform: device.platform, slot: device.slot)
    }
  }

  private func deviceTile(
    _ device: DeviceRef, focused: Bool, screenHeight: CGFloat, replay: ReplayController?, replaying: Bool
  ) -> some View {
    DeviceTile(
      device: device, screenHeight: screenHeight,
      interactive: device.isRunning && takenOver == device.id && !replaying, workspace: env.path,
      workspaceTitle: env.names.title,
      build: env.runningBuild(for: device),
      takenOver: takenOver == device.id && !replaying,
      onToggleTakeOver: device.isInteractive
        ? {
          takenOver = takenOver == device.id ? nil : device.id
          focusedID = device.id
        } : nil,
      replay: replay, replaying: replaying, replayOff: env.replayOff,
      onReplaySeek: { if takenOver == device.id { takenOver = nil } },
      usage: device.isRunning ? env.usage(of: device, machine: machine) : nil,
      presence: env.appPresence(device),
      cli: cli,
      showsCovers: true,
      focused: focused)
  }
}

/// Re-renders its content as the replay starts, stops or moves.
private struct ReplayingTile<Content: View>: View {
  @ObservedObject var replay: ReplayController
  @ViewBuilder var content: (Bool) -> Content

  var body: some View { content(replay.replay != nil) }
}

extension DeviceRef {
  var canvasAspect: CGFloat {
    if !isRunning { return 0.52 }
    if case .remote = self { return 0.6 }
    switch formFactor {
    case .phone: return 0.52
    case .tablet: return 0.78
    case .dual: return 1.4
    case .desktop: return 1.6
    }
  }
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
