import StimKit
import StimStores
import SwiftUI

struct WorkspaceDetail: View {
  var cli: Task<StimCLI, Never>
  var statsReader: StatsReader
  var env: Workspace
  var page: WorktreePage
  var selectedPath: String
  var sampled: [String: UsageHistory]
  var usage: UsageHistory?
  var machine: MachineUsage?
  var reportsBundles: Bool
  var history: OwnerHistory
  var inspector: InspectorPresentation
  @Binding var inspectorWidth: CGFloat
  @Binding var focusedID: String?
  @Binding var logQuery: LogQuery
  @Binding var logWorkspacePath: String?
  @State private var stats: (path: String, fetched: Fetched<ProjectStats>)?
  @State private var groupStats: [String: Fetched<ProjectStats>] = [:]
  @State private var contentHeight: CGFloat = 0
  @State private var viewing: ViewedDevice?
  @State private var buildSheet: BuildSheetSelection?
  @State private var logMoment: LogMoment?
  @EnvironmentObject private var actions: ActionCenter
  @EnvironmentObject private var checks: BuildPlanChecks
  @ObservedObject private var server = ServerSession.shared
  @Environment(\.windowSize) private var windowSize
  @Environment(\.tutorialHint) private var tutorialHint
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

  var archived: [ArchivedWorkspace] = []
  var openArchive: (String) -> Void = { _ in }

  var archive: ArchivedWorkspace? = nil
  var archiveEnvironments: [Workspace] = []
  var openReplacement: (String) -> Void = { _ in }
  @State private var archiveNow = Date()
  @State private var archiveDetail: ArchiveDetail?
  @State private var archiveError: String?
  @State private var confirmingArchiveDelete = false
  #if DEBUG
    var fixtureDate: Date? = nil
    var fixtureDetail: ArchiveDetail? = nil
    var readsServer = true
  #else
    private var fixtureDate: Date? { nil }
    private var fixtureDetail: ArchiveDetail? { nil }
    private var readsServer: Bool { true }
  #endif

  private var archivedPage: ArchivedPage? {
    archive.map { ArchivedPage(archive: $0, detail: fixtureDetail ?? archiveDetail, now: fixtureDate ?? archiveNow) }
  }

  private var workspace: Workspace { archivedPage?.workspace ?? env }

  static func archived(
    _ archive: ArchivedWorkspace, cli: Task<StimCLI, Never>, statsReader: StatsReader,
    environments: [Workspace] = [], inspector: InspectorPresentation = .column,
    inspectorWidth: Binding<CGFloat> = .constant(320),
    logQuery: Binding<LogQuery> = .constant(LogQuery()), openReplacement: @escaping (String) -> Void = { _ in }
  ) -> Self {
    let adapted = ArchivedPage(archive: archive, now: Date())
    return Self(
      cli: cli, statsReader: statsReader, env: adapted.workspace,
      page: WorktreePage.groups(environments: [adapted.workspace])[0], selectedPath: archive.projectRoot,
      sampled: [:], usage: nil, machine: nil, reportsBundles: false, history: OwnerHistory(),
      inspector: inspector, inspectorWidth: inspectorWidth, focusedID: .constant(nil), logQuery: logQuery,
      logWorkspacePath: .constant(nil), archive: archive, archiveEnvironments: environments, openReplacement: openReplacement)
  }

  var body: some View {
    let devices = workspace.orderedDevices
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
    .navigationTitle(workspace.names.title)
    .sheet(item: $viewing) { viewed in
      DeviceViewer(
        cli: cli, env: page.apps.first { $0.path == viewed.workspace } ?? workspace, deviceID: viewed.id, machine: machine,
        windowSize: windowSize,
        revealInLogs: { slot, at in
          logWorkspacePath = viewed.workspace
          revealAgentActions(slot: slot, at: at)
        }, close: { viewing = nil }
      )
      .environmentObject(actions)
      .environment(\.tutorialHint, tutorialHint)
    }
    .sheet(item: $buildSheet) { selection in
      Group {
        if page.isUnified {
          BuildSheet(
            cli: cli, env: workspace, selection: selection, page: page,
            openLogs: openBuildLogs,
            openAppLogs: { app, query in
              logWorkspacePath = app.path
              openBuildLogs(query)
            })
        } else {
          BuildSheet(
            cli: cli, env: workspace, selection: selection, openLogs: openBuildLogs, archive: archive,
            logsExpired: archivedPage?.logsExpired ?? false, readsServer: readsServer)
        }
      }
      .environmentObject(actions)
      .environmentObject(checks)
      .environment(\.tutorialHint, tutorialHint)
    }
    .confirmationDialog(
      "Delete \(archive?.title ?? "archive") (\(archive?.removedLabel(now: fixtureDate ?? Date()) ?? ""))?",
      isPresented: $confirmingArchiveDelete, titleVisibility: .visible
    ) {
      Button("Delete Permanently", role: .destructive) {
        if let archive {
          actions.run(
            "Delete \(archive.title)", steps: [archive.deleteCommand(cwd: NSHomeDirectory())], key: ActionCenter.machineKey)
        }
      }
    } message: {
      Text("This permanently deletes this archive's logs, recordings, agent actions and record.")
    }
    .task(id: archive?.id) {
      guard archive != nil, fixtureDate == nil else { return }
      while !Task.isCancelled {
        archiveNow = Date()
        do { try await Task.sleep(for: .seconds(30)) } catch { return }
      }
    }
    .task(id: "\(archive?.id ?? "")|\(server.isOpen)") {
      guard readsServer, let archive, server.isOpen, let client = server.client else { return }
      do {
        let detail = try await client.archiveDetail(ArchiveDetailRequest(archive: archive.id))
        guard !Task.isCancelled else { return }
        archiveDetail = detail
        archiveError = nil
      } catch {
        guard !Task.isCancelled else { return }
        archiveError =
          (error as? ServerError)?.code == "unknown-method" ? nil : archivedReadError(error, content: "build history")
      }
    }
    .onQuitRequested {
      viewing = nil
      buildSheet = nil
    }
    .onAppear {
      if page.isUnified || !page.apps.contains(where: { $0.path == logWorkspacePath }) { logWorkspacePath = selectedPath }
    }
    .onChange(of: selectedPath) {
      if page.isUnified {
        logWorkspacePath = selectedPath
      }
    }
    .task(id: page.apps.map { "\($0.path)|\($0.finishedRunsStamp)" }.joined(separator: "\n")) {
      guard readsServer, archive == nil else { return }
      if page.isUnified {
        for app in page.apps {
          let path = app.path
          if groupStats[path] != nil || stats?.path == path { try? await Task.sleep(for: .seconds(1)) }
          let result = await Result.awaiting { try await statsReader.project(workspace: path) }
          guard !Task.isCancelled else { return }
          var fetched = Fetched<ProjectStats>()
          fetched.record(result)
          groupStats[path] = fetched
        }
      } else {
        let path = workspace.path
        if stats?.path == path { try? await Task.sleep(for: .seconds(1)) }
        let result = await Result.awaiting { try await statsReader.project(workspace: path) }
        guard !Task.isCancelled else { return }
        var fetched = Fetched<ProjectStats>()
        fetched.record(result)
        stats = (path, fetched)
      }
    }
  }

  private func content(devices: [DeviceRef], focused: DeviceRef?) -> some View {
    VStack(spacing: 0) {
      HStack(spacing: Space.md) {
        if archive != nil, let archivedPage {
          ArchivedHeaderLine(cli: cli, page: archivedPage) { confirmingArchiveDelete = true }
        } else {
          WorkspaceHeaderLine(
            cli: cli, env: workspace, page: page.isUnified ? page : nil,
            openAppLogs: { app in
              logWorkspacePath = app.path
              logQuery.errorsOnly = false
              showsLogs = true
            },
            openLogs: {
              logQuery.errorsOnly = false
              showsLogs = true
            },
            openBuild: { buildSheet = $0 }
          )
        }
        if !showsLogs, tutorialHint?.path == workspace.path,
          ["logs", "refresh"].contains(tutorialHint?.step ?? "")
        {
          LogsToggleButton(isShown: false, errors: workspace.logs?.errorsSinceMarker ?? 0) {
            showsLogs = true
          }
          .tutorialAnchor(.logsTab, workspace: workspace.path)
        }
      }
      .padding(.horizontal, PageInset.horizontal)
      .padding(.vertical, Space.md)
      let earlier = ArchivedWorkspace.newestFirst(
        archived.filter { archive in page.apps.contains { archive.isEarlierRun(of: $0.path) } })
      if archive == nil && !earlier.isEmpty {
        FlowLayout(spacing: Space.md) {
          Text("Earlier runs").foregroundStyle(Palette.secondary)
          ForEach(earlier) { archive in
            Button(archive.removedLabel(now: Date())) { openArchive(archive.id) }
              .buttonStyle(.link).help(archive.title)
          }
        }
        .font(.stim(.footnote)).padding(.horizontal, PageInset.horizontal).padding(.bottom, Space.md)
      }
      Rectangle().fill(Palette.border).frame(height: 1)
      VStack(spacing: 0) {
        Group {
          if let archive, let archivedPage {
            archiveCanvas(archive: archive, adapted: archivedPage)
          } else if page.isUnified {
            unifiedCanvas
          } else {
            canvas(devices: devices, focused: focused)
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        if showsLogs {
          Rectangle().fill(Palette.border).frame(height: 1).overlay { logsResizeHandle }
          Group {
            if archivedPage?.logsExpired == true {
              InlineEmpty("Logs expired").padding(Space.xxl)
            } else if !readsServer {
              InlineEmpty("Archived logs are read through stim-server.").padding(Space.xxl)
            } else {
              LogsView(
                cli: cli, env: archive == nil ? (page.isUnified ? logsApp : workspace) : nil, query: $logQuery,
                moment: $logMoment,
                page: page.isUnified ? page : nil, selectedApp: $logWorkspacePath, archive: archive
              )
              .tutorialAnchor(.logsTab, workspace: workspace.path)
              .frame(height: Self.clampedLogsHeight(logsHeight, contentHeight: contentHeight))
            }
          }

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

  private var logsApp: Workspace {
    page.apps.first { $0.path == logWorkspacePath } ?? page.apps.first { $0.path == selectedPath } ?? workspace
  }

  @ViewBuilder private var inspectorPanel: some View {
    if page.isUnified {
      WorktreeInspector(
        cli: cli, page: page, stats: groupStats, machine: machine, sampled: sampled, history: history,
        reportsBundles: reportsBundles,
        openLogs: { app, query in
          if let app { logWorkspacePath = app.path }
          openBuildLogs(query)
        },
        openBuild: { buildSheet = $0 }
      ).frame(maxHeight: .infinity)
    } else {
      Inspector(
        cli: cli, env: workspace, stats: stats.flatMap { $0.path == workspace.path ? $0.fetched : nil } ?? Fetched(),
        machine: machine, usage: usage, history: history,
        reportsBundles: reportsBundles,
        openLogs: openBuildLogs,
        openBuild: { buildSheet = $0 }, archive: archivedPage
      )
      .frame(maxHeight: .infinity)
    }
  }

  private func openBuildLogs(_ query: LogQuery) {
    logQuery = query
    logMoment = nil
    showsLogs = true
  }

  private func archiveCanvas(archive: ArchivedWorkspace, adapted: ArchivedPage) -> some View {
    let recordings = (fixtureDetail ?? archiveDetail).map { _ in adapted.recordings }
    return ScrollView {
      VStack(alignment: .leading, spacing: Space.xxl) {
        if let path = adapted.replacedBy {
          Button("Replaced by \(archiveEnvironments.first(where: { $0.path == path })?.names.title ?? path)") {
            openReplacement(path)
          }.buttonStyle(.link)
        }
        SectionLabel(title: "Devices")
        if adapted.recordingsExpired {
          InlineEmpty("Recordings expired")
        }
        if readsServer {
          ArchivedReplays(archive: archive.id, recordings: recordings)
            .id("\(archive.id)|\(recordings != nil)|\(adapted.recordings.map(\.id).joined(separator: ","))")
          if recordings?.isEmpty == true && !adapted.recordingsExpired { InlineEmpty("No recordings retained") }
        } else if adapted.recordings.isEmpty {
          if !adapted.recordingsExpired { InlineEmpty("No recordings retained") }
        } else {
          ForEach(adapted.recordings) { recording in
            Card {
              VStack(alignment: .leading, spacing: Space.md) {
                SectionLabel(title: "Replay \u{00B7} \(platformName(recording.platform)) \u{00B7} \(recording.slot)")
                InlineEmpty("Recorded footage is read through stim-server.")
              }.padding(Space.xxl)
            }
          }
        }
        if let archiveError { Text(archiveError).foregroundStyle(Palette.secondary) }
      }.padding(.horizontal, PageInset.horizontal).padding(.vertical, Space.xxl).frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func canvas(devices: [DeviceRef], focused: DeviceRef?) -> some View {
    GeometryReader { geo in
      ScrollView {
        if devices.isEmpty {
          emptyCanvas.frame(maxWidth: .infinity).padding(Space.xxxl)
        } else {
          let availableWidth = max(0, geo.size.width - PageInset.horizontal * 2)
          let cardWidth = min(Self.maximumCardWidth, availableWidth)
          let cardHeight = max(0, geo.size.height - Space.xxl * 2)
          FlowLayout(spacing: Space.xl, lineSpacing: Space.xl, topAligned: true, centered: true) {
            ForEach(devices) { device in
              tile(device, focused: device.id == focused?.id, cardWidth: cardWidth, cardHeight: cardHeight)
            }
          }
          .padding(.horizontal, PageInset.horizontal).padding(.vertical, Space.xxl)
        }
      }
    }
  }

  private var unifiedCanvas: some View {
    let devices = page.orderedDevices
    let entries = page.canvasEntries
    let target = page.canvasScrollTarget(selectedPath: selectedPath, focusedID: focusedID, devices: devices).map {
      $0 == devices.first?.id ? "devices" : $0
    }
    return GeometryReader { geo in
      ScrollViewReader { reader in
        ScrollView {
          if entries.isEmpty {
            TimelineView(.periodic(from: .now, by: 30)) { context in
              emptyCanvas(stage: page.lead(now: context.date).stage(now: context.date))
            }.frame(maxWidth: .infinity).padding(Space.xxxl)
          } else if !devices.isEmpty {
            let cardWidth = min(Self.maximumCardWidth, max(0, geo.size.width - PageInset.horizontal * 2))
            let cardHeight = max(0, geo.size.height - Space.xxl * 2)
            FlowLayout(spacing: Space.xl, lineSpacing: Space.xl, topAligned: true, centered: true) {
              ForEach(devices) { entry in
                tile(
                  entry.device, focused: entry.device.id == focusedID, cardWidth: cardWidth, cardHeight: cardHeight,
                  owner: entry.workspace, project: page.subtitle(for: entry.entry, among: entries)
                ).id(entry.id)
              }
            }.padding(.horizontal, PageInset.horizontal).padding(.vertical, Space.xxl).id("devices")
          }
        }
        .onChange(of: selectedPath, initial: true) {
          if let target { reader.scrollTo(target, anchor: .top) }
        }
        .onChange(of: focusedID) {
          if devices.contains(where: { $0.workspace.path == selectedPath && $0.device.id == focusedID }), let target {
            reader.scrollTo(target, anchor: .top)
          }
        }
      }
    }
  }

  private var emptyCanvas: some View {
    TimelineView(.periodic(from: .now, by: 30)) { context in
      emptyCanvas(stage: workspace.stage(now: context.date))
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
        Text("No Devices").font(.stim(.headline))
        Text("Run stim ios or stim android to launch your app.")
          .foregroundStyle(Palette.secondary)
          .multilineTextAlignment(.center)
      }
      .padding(Space.huge)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .id(workspace.path)
    }
  }

  private func tile(
    _ device: DeviceRef, focused: Bool, cardWidth: CGFloat, cardHeight: CGFloat, owner: Workspace? = nil, project: String? = nil
  ) -> some View {
    let workspace = owner ?? self.workspace
    let canControl =
      device.isInteractive
      && ((!device.isPhysical && device.hostedMachine == nil)
        || PhysicalScreen(device: device, link: server.link, now: Date()).canControl)
    let build = workspace.runningBuild(for: device)
    let status = DeviceTileStatus(device: device, canControl: canControl, building: build != nil)
    let tile = DeviceTile(
      device: device, screenHeight: 900, workspace: workspace.path, project: project,
      build: build,
      usage: device.isRunning ? workspace.usage(of: device, machine: machine) : nil,
      presence: workspace.appPresence(device),
      showsCovers: true,
      focused: focused,
      status: status,
      maxWidth: cardWidth, maxCardHeight: cardHeight,
      showsScreen: viewing?.id != device.id || viewing?.workspace != workspace.path,
      onBuildLogs: macosBuildLogs(device, workspace: workspace.path), clickThrough: true
    )
    return
      tile
      .tutorialAnchor(.deviceTile, workspace: workspace.path)
      .background {
        Button {
          focusedID = device.id
          viewing = ViewedDevice(id: device.id, workspace: workspace.path)
        } label: {
          Color.clear.contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(status.headerAction == nil)
        .help(
          status.headerAction == nil
            ? "" : canControl ? "Control \(device.label) or replay what it recorded" : "View \(device.label)"
        )
        .accessibilityLabel(status.headerAction.map { "\($0.rawValue) \(device.label)" } ?? device.label)
      }
      .frame(width: tile.showsStoppedBar ? min(DeviceTile.stoppedMaximumWidth, cardWidth) : cardWidth)
  }

  private func macosBuildLogs(_ device: DeviceRef, workspace path: String) -> (() -> Void)? {
    guard case .macos(let app) = device,
      let query = LogQuery.build(
        platform: "macos", slot: "default", startedAt: app.build.startedAt, finishedAt: app.build.finishedAt)
    else { return nil }
    return {
      logWorkspacePath = path
      openBuildLogs(query)
    }
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
  var workspace: String
}
