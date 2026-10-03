import StimKit
import StimStores
import SwiftUI

struct WorkspaceDetail: View {
  var cli: Task<StimCLI, Never>
  var statsReader: StatsReader
  var env: Workspace
  var usage: UsageHistory?
  var machine: MachineUsage?
  var reportsBundles: Bool
  var history: OwnerHistory
  var inspector: InspectorPresentation
  @Binding var inspectorWidth: CGFloat
  @Binding var focusedID: String?
  @Binding var logQuery: LogQuery
  @State private var stats: (path: String, fetched: Fetched<ProjectStats>)?
  @State private var contentHeight: CGFloat = 0
  @State private var viewing: ViewedDevice?
  @State private var logMoment: LogMoment?
  @EnvironmentObject private var actions: ActionCenter
  @ObservedObject private var server = ServerSession.shared
  @Environment(\.windowSize) private var windowSize
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
  private static let maximumCardWidth: CGFloat = 640

  var body: some View {
    let devices = env.orderedDevices
    let focused = devices.first { $0.id == focusedID } ?? devices.first
    HStack(spacing: 0) {
      content(devices: devices, focused: focused)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      if inspector == .column {
        Rectangle().fill(Palette.border).frame(width: 1).ignoresSafeArea(edges: .top)
          .overlay { resizeHandle }
        inspectorPanel
          .frame(width: Self.clampedInspectorWidth(inspectorWidth, detailWidth: width))
          .background(Palette.sidebar)
      }
    }
    .onGeometryChange(for: CGFloat.self) {
      $0.size.width
    } action: {
      width = $0
    }
    .overlay(alignment: .trailing) {
      if inspector == .overlay {
        inspectorPanel
          .frame(width: Self.inspectorWidth)
          .background(Palette.sidebar)
          .overlay(alignment: .leading) {
            Rectangle().fill(Palette.border).frame(width: 1).ignoresSafeArea(edges: .top)
          }
          .compositingGroup()
          .shadow(color: .black.opacity(0.25), radius: 16)
      }
    }
    .navigationTitle(env.names.title)
    .sheet(item: $viewing) { viewed in
      DeviceViewer(
        cli: cli, env: env, deviceID: viewed.id, machine: machine, windowSize: windowSize,
        revealInLogs: revealAgentActions, close: { viewing = nil }
      )
      .environmentObject(actions)
    }
    .onQuitRequested { viewing = nil }
    .task(id: "\(env.path)|\(env.finishedRunsStamp)") {
      let path = env.path
      if stats?.path == path { try? await Task.sleep(for: .seconds(1)) }
      let result = await Result.awaiting { try await statsReader.project(workspace: path) }
      guard !Task.isCancelled else { return }
      var fetched = Fetched<ProjectStats>()
      fetched.record(result)
      stats = (path, fetched)
    }
  }

  private func content(devices: [DeviceRef], focused: DeviceRef?) -> some View {
    VStack(spacing: 0) {
      WorkspaceHeaderLine(
        env: env,
        openLogs: {
          logQuery.errorsOnly = false
          showsLogs = true
        }
      )
      .padding(.horizontal, Space.xxl)
      .padding(.vertical, Space.md)
      Rectangle().fill(Palette.border).frame(height: 1)
      VStack(spacing: 0) {
        canvas(devices: devices, focused: focused)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        if showsLogs {
          Rectangle().fill(Palette.border).frame(height: 1).overlay { logsResizeHandle }
          LogsView(cli: cli, env: env, query: $logQuery, moment: $logMoment)
            .frame(height: Self.clampedLogsHeight(logsHeight, contentHeight: contentHeight))
        }
      }
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        contentHeight = $0
      }
    }
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
          .onEnded { _ in logsResizeStart = nil }
      )
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
      cli: cli, env: env, stats: stats.flatMap { $0.path == env.path ? $0.fetched : nil } ?? Fetched(),
      machine: machine, usage: usage, history: history,
      reportsBundles: reportsBundles,
      openLogs: { query in
        logQuery = query
        logMoment = nil
        showsLogs = true
      }
    )
    .frame(maxHeight: .infinity)
  }

  private func canvas(devices: [DeviceRef], focused: DeviceRef?) -> some View {
    GeometryReader { geo in
      ScrollView {
        if devices.isEmpty {
          emptyCanvas.frame(maxWidth: .infinity).padding(Space.xxxl)
        } else {
          let availableWidth = max(0, geo.size.width - Space.xxl * 2)
          let cardWidth = min(Self.maximumCardWidth, availableWidth)
          let cardHeight = max(0, geo.size.height - Space.xxl * 2)
          FlowLayout(spacing: Space.xl, lineSpacing: Space.xl, topAligned: true, centered: true) {
            ForEach(devices) { device in
              tile(device, focused: device.id == focused?.id, cardWidth: cardWidth, cardHeight: cardHeight)
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
      .overlay(
        RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    } else {
      VStack(spacing: Space.lg) {
        NoDeviceArt()
        Text("No devices").font(.stim(.headline))
        Text("Run stim ios or stim android to launch your app.")
          .foregroundStyle(Palette.secondary)
          .multilineTextAlignment(.center)
      }
      .padding(Space.huge)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .id(env.path)
    }
  }

  private func tile(_ device: DeviceRef, focused: Bool, cardWidth: CGFloat, cardHeight: CGFloat) -> some View {
    let canControl =
      device.isInteractive
      && (!device.isPhysical || PhysicalScreen(device: device, link: server.link, now: Date()).canControl)
    let viewerAction = canControl ? "Control" : "View"
    let tile = DeviceTile(
      device: device, screenHeight: 900, workspace: env.path,
      build: env.runningBuild(for: device),
      usage: device.isRunning ? env.usage(of: device, machine: machine) : nil,
      presence: env.appPresence(device),
      showsCovers: true,
      focused: focused,
      viewerAction: viewerAction,
      maxWidth: cardWidth, maxCardHeight: cardHeight,
      showsScreen: viewing?.id != device.id
    )
    return
      tile
      .allowsHitTesting(tile.showsStoppedBar)
      .background {
        Button {
          focusedID = device.id
          viewing = ViewedDevice(id: device.id)
        } label: {
          Color.clear.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(canControl ? "Control \(device.label) or replay what it recorded" : "View \(device.label)")
        .accessibilityLabel("\(viewerAction) \(device.label)")
      }
      .frame(width: tile.showsStoppedBar ? min(DeviceTile.stoppedMaximumWidth, cardWidth) : cardWidth)
  }

  /// Shows the agent source of `slot` in the logs drawer, scrolled to `at` when given.
  private func revealAgentActions(slot: String, at: Double?) {
    logQuery = LogQuery()
    logQuery.sources = [.agent]
    logQuery.slot = slot
    logQuery.minimumLevel = .debug
    logQuery.errorsOnly = false
    logQuery.search = ""
    showsLogs = true
    logMoment = at.map { LogMoment(at: $0) }
  }
}

struct ViewedDevice: Identifiable {
  var id: String
}
