import StimKit
import SwiftUI

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
  @Binding var logQuery: LogQuery
  @State private var stats: ProjectStats?
  @State private var contentHeight: CGFloat = 0
  @State private var takenOver: String?
  @State private var logsResizeStart: CGFloat?
  @AppStorage(AppPreferences.Key.logsDrawerHeight) private var logsHeight = Double(WorkspaceDetail.defaultLogsHeight)
  @AppStorage(AppPreferences.Key.showsLogs) private var showsLogs = false
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
      WorkspaceHeaderLine(
        env: env,
        openLogs: {
          logQuery.errorsOnly = false
          showsLogs = true
        })
        .padding(.horizontal, Space.xxl)
        .padding(.vertical, Space.md)
      Rectangle().fill(Palette.border).frame(height: 1)
      canvas(devices: devices, focused: focused)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      if showsLogs {
        Rectangle().fill(Palette.border).frame(height: 1).overlay { logsResizeHandle }
        LogsView(cli: cli, env: env, query: $logQuery)
          .frame(height: Self.clampedLogsHeight(logsHeight, contentHeight: contentHeight))
      }
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
  }

  static let minimumLogsHeight: CGFloat = 160
  static let defaultLogsHeight: CGFloat = 300
  private static let minimumCanvasHeight: CGFloat = 240

  static func clampedLogsHeight(_ proposed: CGFloat, contentHeight: CGFloat) -> CGFloat {
    max(minimumLogsHeight, min(contentHeight - 1 - minimumCanvasHeight, proposed))
  }

  private var logsResizeHandle: some View {
    Color.clear
      .frame(height: 8)
      .contentShape(Rectangle())
      .onHover { inside in
        if inside { NSCursor.resizeUpDown.push() } else { NSCursor.pop() }
      }
      .gesture(
        DragGesture(minimumDistance: 1, coordinateSpace: .global)
          .onChanged { drag in
            let start = logsResizeStart ?? Self.clampedLogsHeight(logsHeight, contentHeight: contentHeight)
            logsResizeStart = start
            logsHeight = Self.clampedLogsHeight(start - drag.translation.height, contentHeight: contentHeight)
          }
          .onEnded { _ in logsResizeStart = nil })
      .help("Drag to resize the logs")
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
    Inspector(
      cli: cli, env: env, stats: stats, machine: machine, usage: usage, history: history,
      reportsBundles: reportsBundles, showsLogs: showsLogs, toggleLogs: { showsLogs.toggle() }
    )
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
