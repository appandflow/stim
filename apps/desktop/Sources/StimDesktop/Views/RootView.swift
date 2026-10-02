import StimKit
import StimStores
import SwiftUI

enum SidebarItem: Hashable {
  case wall
  case project(Project)
  case environment(String)
  case worktree(String)
  case notifications
  case machine
}

struct RootView: View {
  @ObservedObject private var store: StatusStore
  private let metrics: MetricsStore
  private let gc: GcReportStore
  private let buildMachines: BuildMachinesModel
  @ObservedObject private var actions: ActionCenter
  private let autopilot: AutopilotRunner
  private let onboarding: Onboarding
  private let storage: StorageStore
  private let planChecks: BuildPlanChecks
  @State private var selection: SidebarItem? = .wall
  @State private var restoredProject = false
  @AppStorage(AppPreferences.Key.defaultView) private var defaultView = DefaultView.allDevices
  @AppStorage(AppPreferences.Key.lastProjectPath) private var lastProjectPath = ""
  @State private var projectFilter: Project?
  @State private var focusedDeviceID: String?
  @State private var logQuery = LogQuery()
  @AppStorage(AppPreferences.Key.showsLogs) private var showsLogs = false
  @AppStorage(AppPreferences.Key.showsInspector) private var showsInspector = true
  @State private var showsInspectorOverlay = false
  @State private var inspectorWidth = WorkspaceDetail.inspectorWidth
  @State private var windowSize = CGSize.zero
  @State private var sidebarWidth: CGFloat = 0
  @State private var detailWidth: CGFloat = 0
  @State private var columnVisibility = NavigationSplitViewVisibility.all
  @ObservedObject private var openRequests = OpenRequests.shared
  private let toasts = ToastCenter.shared
  private let notices = NoticeCenter.shared
  @AppStorage(AppPreferences.Key.dismissedStimUpdate) private var dismissedStimUpdate = ""
  @State private var pendingLink: PendingWorkspaceLink?
  @Environment(\.openWindow) private var openWindow

  private let cli: Task<StimCLI, Never>

  init(
    cli: Task<StimCLI, Never>, store: StatusStore, actions: ActionCenter, autopilot: AutopilotRunner,
    onboarding: Onboarding, gc: GcReportStore, buildMachines: BuildMachinesModel, metrics: MetricsStore,
    storage: StorageStore, planChecks: BuildPlanChecks
  ) {
    self.buildMachines = buildMachines
    self.cli = cli
    self.onboarding = onboarding
    self.store = store
    self.actions = actions
    self.autopilot = autopilot
    self.gc = gc
    self.metrics = metrics
    self.storage = storage
    self.planChecks = planChecks
  }

  var body: some View {
    NavigationSplitView(columnVisibility: $columnVisibility) {
      Sidebar(
        store: store, autopilot: autopilot, onboarding: onboarding, actions: actions, selection: $selection, openLogs: showLogs
      )
      .frame(minWidth: 220, idealWidth: 272, maxWidth: .infinity)
      .navigationSplitViewColumnWidth(min: 220, ideal: 272, max: 360)
      .onGeometryChange(for: CGFloat.self) {
        $0.size.width
      } action: {
        sidebarWidth = $0
      }
    } detail: {
      detail
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.background)
        .toolbarBackdrop(showsWorkspace ? .clear : Palette.background)
        .overlay(alignment: .bottom) { onboardingPopup }
        .overlay(alignment: .topTrailing) { ToastStack(center: toasts) }
        .overlay(alignment: .bottomLeading) { NoticeStack(center: notices) }
        .onGeometryChange(for: CGFloat.self) {
          $0.size.width
        } action: {
          detailWidth = $0
        }
        .navigationSplitViewColumnWidth(min: 440, ideal: 900)
        .toolbar {
          ToolbarItem(placement: .navigation) {
            if columnVisibility == .detailOnly {
              OperationsButton(log: actions.operations, actions: actions, store: store, arrowEdge: .bottom)
            }
          }
          ToolbarItem(id: summaryItemID, placement: .navigation) {
            MachineSummary(store: store, metrics: metrics, gc: gc, width: summaryWidth)
          }
          if showsWorkspace {
            ToolbarItem(placement: .primaryAction) { Spacer() }
            ToolbarItem(placement: .primaryAction) {
              LogsToggleButton(isShown: showsLogs, errors: selectedWorkspace?.logs?.errorsSinceMarker ?? 0) {
                showsLogs.toggle()
              }
            }
            ToolbarItem(placement: .primaryAction) {
              InspectorToggleButton(isShown: inspector != .hidden, action: toggleInspector)
            }
          }
        }
    }
    .focusedSceneValue(
      \.inspectorToggle,
      showsWorkspace ? InspectorToggle(isShown: inspector != .hidden, toggle: toggleInspector) : nil
    )
    .focusedSceneValue(\.sidebarNavigation, SidebarNavigation { selection = $0 })
    .onChange(of: inspectorFits) { showsInspectorOverlay = false }
    .onGeometryChange(for: CGSize.self) {
      $0.size
    } action: {
      windowSize = $0
    }
    .environment(\.windowSize, windowSize)
    .toolbarBackground(.hidden, for: .windowToolbar)
    .tint(Palette.brand)
    .font(.stim(.body))
    .foregroundStyle(Palette.text)
    .environmentObject(actions)
    .environmentObject(planChecks)
    .environment(\.workspaceTitle, workspaceTitles)
    .sheet(item: $actions.presented) { run in
      ActivitySheet(run: run).environmentObject(actions)
    }
    .onQuitRequested { actions.presented = nil }
    .modifier(SetupGuidePresenter(onboarding: onboarding, actions: actions))
    .onAppear {
      store.start()
      openRequests.openMainWindow = { [openWindow] in openWindow(id: "main") }
    }
    .onDisappear { notices.removeAll() }
    .onChange(of: onboarding.stimUpdate, initial: true) { _, latest in showStimUpdate(latest) }
    .onChange(of: openRequests.target, initial: true) { _, target in show(target, in: store.payload) }
    .onReceive(openRequests.$device) { request in showDevice(request, in: store.payload) }
    .onReceive(openRequests.$workspaceLink) { link in
      guard link != nil else { return }
      Task { takeWorkspaceLink() }
    }
    .onReceive(store.$payload) { payload in
      showDevice(openRequests.device, in: payload)
      showWorkspaceLink(in: payload)
      show(openRequests.target, in: payload)
      if case .worktree(let path) = selection, payload?.environments.contains(where: { $0.path == path }) == true {
        selection = .environment(path)
      }
      restoreLastProject()
    }
    .onReceive(store.$projects) { _ in restoreLastProject() }
    .onReceive(openRequests.$showsMachine) { shows in
      guard shows else { return }
      openRequests.showsMachine = false
      selection = .machine
    }
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
      case .worktree:
        openRequests.selectedWorkspace = nil
      default: break
      }
    }
  }

  private var showsWorkspace: Bool {
    if case .environment = selection { return true }
    return false
  }

  private var selectedWorkspace: Workspace? {
    guard case .environment(let path) = selection else { return nil }
    return store.payload?.environments.first { $0.path == path }
  }

  private var inspectorFits: Bool {
    windowSize.width - (columnVisibility == .detailOnly ? 0 : sidebarWidth) >= WorkspaceDetail.widthWithInspector
  }

  private var inspector: InspectorPresentation {
    if inspectorFits { return showsInspector ? .column : .hidden }
    return showsInspectorOverlay ? .overlay : .hidden
  }

  private var workspaceTitles: WorkspaceTitles {
    WorkspaceTitles(
      titles: Dictionary(
        (store.payload?.environments ?? []).map { ($0.path, $0.names.title) }, uniquingKeysWith: { first, _ in first }))
  }

  private func toggleInspector() {
    if inspectorFits { showsInspector.toggle() } else { showsInspectorOverlay.toggle() }
  }

  /// Leaves room for the inspector, column or floating, so the popup never sits under it.
  @ViewBuilder private var onboardingPopup: some View {
    HStack(spacing: 0) {
      OnboardingBanner(onboarding: onboarding).frame(maxWidth: .infinity)
      if showsWorkspace, inspector == .column {
        Color.clear.frame(width: WorkspaceDetail.clampedInspectorWidth(inspectorWidth, detailWidth: detailWidth) + 1)
      } else if showsWorkspace, inspector == .overlay {
        Color.clear.frame(width: WorkspaceDetail.inspectorWidth)
      }
    }
  }

  /// macOS moves the traffic lights and the sidebar toggle into the detail's toolbar when the sidebar is hidden.
  private var summaryWidth: CGFloat {
    detailWidth - (columnVisibility == .detailOnly ? 200 : 80) - (showsWorkspace ? 88 : 0)
      - (showsWorkspace && inspector == .column
        ? WorkspaceDetail.clampedInspectorWidth(inspectorWidth, detailWidth: detailWidth) + 1 : 0)
  }

  /// NSToolbar measures an item when it is inserted or the window resizes, not when a SwiftUI item grows, so the
  /// summary is reinserted whenever the room it gets changes.
  private var summaryItemID: String {
    "machine-summary-\(showsWorkspace)-\(showsWorkspace && inspector == .column)"
  }

  private func restoreLastProject() {
    guard !restoredProject, defaultView == .lastProject, !lastProjectPath.isEmpty, selection == .wall else { return }
    guard let entry = store.projectList.first(where: { $0.project.root == lastProjectPath }) else { return }
    restoredProject = true
    selection = .project(entry.project)
  }

  /// `@Published` emits before the property changes, so both values arrive as arguments.
  private func showDevice(_ request: DeviceOpenRequest?, in payload: StatusPayload?) {
    guard let request, let owner = payload?.owner(of: request) else { return }
    openRequests.device = nil
    let path = owner.workspace.path
    let deviceID = owner.device.id
    let page: LaunchPage
    switch selection {
    case .wall: page = .allDevices
    case .environment(let current): page = .workspace(current)
    default: page = .other
    }
    switch launchResponse(page: page, mainWindowOpen: openRequests.deviceArrivedWithWindow, workspacePath: path) {
    case .navigate:
      selection = .environment(path)
      focusedDeviceID = deviceID
    case .notice:
      notices.show(
        Notice(
          icon: "iphone", title: "\(owner.device.label) launched for \(owner.workspace.names.title)",
          detail: abbreviatingHome(path), actionTitle: "Show",
          perform: {
            selection = .environment(path)
            focusedDeviceID = deviceID
          }, key: "device-launch:\(deviceID)"))
    }
  }

  private func showStimUpdate(_ latest: SemanticVersion?) {
    guard let latest, latest.description != dismissedStimUpdate,
      case .compatible(let installed)? = onboarding.report?.stim
    else {
      notices.remove(key: "stim-update")
      return
    }
    notices.show(
      Notice(
        icon: "arrow.down.circle", title: "stim \(latest.description) available",
        detail: "You have \(installed.description)", actionTitle: "Update",
        perform: onboarding.installStim,
        onDismiss: { dismissedStimUpdate = latest.description }, key: "stim-update"))
  }

  /// `@Published` emits before the property changes, so the link is read once the assignment has landed.
  private func takeWorkspaceLink() {
    guard let link = openRequests.workspaceLink else { return }
    openRequests.workspaceLink = nil
    guard case .workspace(let request) = link else {
      showWorkspaceNotFound("The link does not name a workspace.")
      return
    }
    pendingLink = PendingWorkspaceLink(request: request)
    showWorkspaceLink(in: store.payload)
  }

  /// A link waits for a status payload that lists its workspace. Once one exists, "Workspace not found" shows after
  /// 10 seconds without a match, and a match within the next minute still replaces it with the workspace's card,
  /// since `stim status --watch` can lag the command that printed the link.
  private func showWorkspaceLink(in payload: StatusPayload?) {
    guard let pending = pendingLink, let payload else { return }
    guard let target = payload.target(of: pending.request) else {
      guard !pending.expiring else { return }
      pendingLink?.expiring = true
      Task {
        try? await Task.sleep(for: .seconds(10))
        guard pendingLink?.id == pending.id else { return }
        showWorkspaceNotFound(
          "Stim does not list \(abbreviatingHome(pending.request.path)) as a workspace.",
          key: "workspace-link:\(pending.request.path)")
        try? await Task.sleep(for: .seconds(60))
        if pendingLink?.id == pending.id { pendingLink = nil }
      }
      return
    }
    pendingLink = nil
    let path = target.workspace.path
    let deviceID = target.device?.id
    toasts.show(
      Toast(
        icon: "macwindow", tone: .accent, title: "\(target.workspace.names.title) \u{00B7} workspace started",
        body: abbreviatingHome(path),
        action: Toast.Action(title: "Open") {
          selection = .environment(path)
          if let deviceID { focusedDeviceID = deviceID }
        },
        sticky: true, key: "workspace-link:\(path)"))
  }

  private func showWorkspaceNotFound(_ body: String, key: String? = nil) {
    toasts.show(Toast(icon: "questionmark.folder", tone: .warning, title: "Workspace not found", body: body, key: key))
  }

  private func show(_ target: OversightTarget?, in payload: StatusPayload?) {
    guard let target, let payload else { return }
    let env = target.path.flatMap { path in payload.environments.first { $0.path == path } }
    openRequests.target = nil
    switch target {
    case .machine:
      selection = .machine
    case .device(let path, let platform, let slot):
      selection = .environment(path)
      if let device = env?.devices.first(where: { device in
        if case .remote = device { return false }
        return device.platform == platform && device.slot == slot
      }) {
        focusedDeviceID = device.id
      }
    case .build(let path, _):
      selection = .environment(path)
      if inspector == .hidden { toggleInspector() }
    case .workspace(let path), .url(let path, _):
      selection = .environment(path)
    case .buildRequest(let id):
      BuildRequestPrompt.present(id: id)
    }
  }

  private func openErrors(_ path: String) {
    selection = .environment(path)
    showsLogs = true
    logQuery.errorsOnly = true
  }

  private func showLogs(_ path: String) {
    selection = .environment(path)
    showsLogs = true
  }

  @ViewBuilder private var detail: some View {
    switch selection {
    case .environment(let path):
      if let env = store.payload?.environments.first(where: { $0.path == path }) {
        WorkspaceDetailHost(
          cli: cli, env: env, metrics: metrics, machine: store.payload?.machine,
          reportsBundles: store.payload?.environments.contains { $0.metro?.bundle != nil } ?? false,
          inspector: inspector, inspectorWidth: $inspectorWidth, focusedID: $focusedDeviceID, logQuery: $logQuery)
      } else {
        EmptyState(title: "Workspace gone", message: "stim status no longer reports this workspace.")
      }
    case .worktree(let path):
      if let worktree = store.payload?.unprovisionedWorktrees?.first(where: { $0.path == path }) {
        NoEnvironmentDetail(worktree: worktree)
      } else {
        EmptyState(title: "Worktree gone", message: "stim status no longer reports this worktree.")
      }
    case .notifications:
      InboxView(inbox: NotificationInbox.shared, openLogs: openErrors)
    case .machine:
      MachineView(buildMachines: buildMachines, status: store, metrics: metrics, gc: gc, storage: storage, autopilot: autopilot)
    default:
      WallView(store: store, metrics: metrics, project: projectFilter, selection: $selection, openLogs: openErrors)
    }
  }
}

private struct WorkspaceDetailHost: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  var metrics: MetricsStore
  var machine: MachineUsage?
  var reportsBundles: Bool
  var inspector: InspectorPresentation
  @Binding var inspectorWidth: CGFloat
  @Binding var focusedID: String?
  @Binding var logQuery: LogQuery

  var body: some View {
    WorkspaceDetail(
      cli: cli, env: env, usage: metrics.usage[env.path], machine: machine, reportsBundles: reportsBundles,
      history: metrics.owners, inspector: inspector, inspectorWidth: $inspectorWidth, focusedID: $focusedID,
      logQuery: $logQuery)
  }
}

private struct PendingWorkspaceLink {
  let id = UUID()
  let request: WorkspaceOpenRequest
  var expiring = false
}

struct MachineSummary: View {
  @ObservedObject var store: StatusStore
  var metrics: MetricsStore
  var gc: GcReportStore
  var width: CGFloat
  @State private var showsDisk = false

  var body: some View {
    ProposedWidth(width: max(0, width)) {
      ViewThatFits(in: .horizontal) {
        row(showsMemory: true, showsBar: true, showsReclaimable: true)
        row(showsMemory: true, showsBar: true, showsReclaimable: false)
        row(showsMemory: true, showsBar: false, showsReclaimable: false)
        row(showsMemory: false, showsBar: false, showsReclaimable: false)
      }
    }
    .font(.stim(.callout))
  }

  private func row(showsMemory: Bool, showsBar: Bool, showsReclaimable: Bool) -> some View {
    HStack(spacing: Space.xl) {
      if let error = store.error {
        Label(abbreviatingHome(error), systemImage: "exclamationmark.triangle.fill").foregroundStyle(Palette.warning)
          .lineLimit(1)
          .frame(maxWidth: 220)
          .help(abbreviatingHome(error))
      }
      if let cap = store.payload?.capacity {
        HStack(spacing: Space.sm) {
          StatusDot(color: Palette.success)
          Text("\(cap.liveCount) live")
        }
        .help("\(countLabel(cap.liveCount, "live workspace")) on this Mac")
        if let cpu = metrics.totalCpuFraction {
          statItem(icon: "cpu", value: formatPercent(cpu * 100), tone: UsageThresholds.cpu(fraction: cpu))
            .help("CPU of every live workspace's processes, simulators and emulators, as a percent of this Mac's cores")
        }
        if showsMemory, let memory = metrics.memory {
          HStack(spacing: Space.sm) {
            statItem(
              icon: "memorychip", value: Format.memoryPair(usedBytes: memory.usedBytes, totalBytes: memory.totalBytes),
              tone: UsageThresholds.memory(memory.pressure))
            if showsBar {
              ProgressView(value: min(1, Double(memory.usedBytes) / Double(max(1, memory.totalBytes))))
                .tint(Color(UsageThresholds.memory(memory.pressure)))
                .frame(width: 50)
            }
          }
          .help(
            "Memory used on this Mac, as Activity Monitor counts it. Stim's share: live workspaces \(store.payload?.machine?.memorySource == .footprint ? "use" : "commit") \(Format.gigabytes(mb: cap.committedMb)) of \(Format.gigabytes(mb: cap.totalMemoryMb))."
          )
        }
      }
      if let lowest = metrics.volumes.min(by: { $0.freeBytes < $1.freeBytes }) {
        Button {
          showsDisk.toggle()
        } label: {
          HStack(spacing: Space.sm) {
            statItem(
              icon: "internaldrive", value: "\(Format.fileSize(lowest.freeBytes)) free",
              tone: UsageThresholds.disk(freeBytes: lowest.freeBytes))
            if showsReclaimable, let reclaimable = gc.report?.reclaimable, reclaimable.bytes > 0 {
              Text("\u{00B7} \(Format.fileSize(reclaimable.bytes)) reclaimable").foregroundStyle(Palette.primary)
            }
          }
        }
        .buttonStyle(.hoverRow(outset: Space.sm))
        .help("Free space on the fullest volume holding the repositories, Stim home or simulators, without purgeable space")
        .popover(isPresented: $showsDisk, arrowEdge: .bottom) {
          DiskPopover(metrics: metrics, gc: gc).presentationBackground(Palette.surface)
        }
      }
      if !store.watching, let at = store.updatedAt {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          Text("\(max(0, Int(context.date.timeIntervalSince(at))))s ago")
            .font(.stim(.caption, mono: true))
            .foregroundStyle(Palette.tertiary)
            .help("Time since the last stim status refresh")
        }
      }
    }
    .padding(.horizontal, Space.md)
  }

  private func statItem(icon: String, value: String, tone: Tone) -> some View {
    HStack(spacing: Space.xs) {
      Image(systemName: icon)
      Text(value).font(.stim(.caption, mono: true)).fixedSize()
    }
    .foregroundStyle(Color(tone))
  }
}

/// macOS proposes no width to a toolbar item, so this proposes `width` to its content and takes the content's size.
private struct ProposedWidth: Layout {
  var width: CGFloat

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    subviews.first?.sizeThatFits(ProposedViewSize(width: width, height: proposal.height)) ?? .zero
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
  }
}

struct DiskPopover: View {
  var metrics: MetricsStore
  var gc: GcReportStore

  var body: some View {
    let volumes = metrics.volumes
    let reclaimable = gc.report?.reclaimable
    VStack(alignment: .leading, spacing: Space.xl) {
      SectionLabel(title: "Disk")
      ForEach(volumes) { volume in
        VStack(alignment: .leading, spacing: Space.sm) {
          HStack {
            Text(volume.name).font(.stim(.callout, weight: .semibold))
            Spacer()
            Text("\(Format.fileSize(volume.freeBytes)) free of \(Format.fileSize(volume.totalBytes))")
              .font(.stim(.caption, mono: true))
              .foregroundStyle(Palette.secondary)
          }
          ProgressView(value: 1 - Double(volume.freeBytes) / Double(max(1, volume.totalBytes)))
            .tint(volume.freeBytes < UsageThresholds.lowDiskBytes ? Palette.warning : Palette.accent)
          Text(volume.holds.joined(separator: ", ")).foregroundStyle(Palette.tertiary)
        }
      }
      Rectangle().fill(Palette.border).frame(height: 1)
      SectionLabel(title: "Reclaimable")
      if let reclaimable {
        if reclaimable.entries == 0 {
          Text("stim gc reports nothing to reclaim.").foregroundStyle(Palette.secondary)
        } else {
          Text(Format.fileSize(reclaimable.bytes)).font(.stim(.title)).foregroundStyle(Palette.primary)
          Text(
            "\(reclaimable.entries) \(reclaimable.entries == 1 ? "entry" : "entries")"
              + (reclaimable.unsized > 0 ? ", \(reclaimable.unsized) of unknown size" : "")
          )
          .foregroundStyle(Palette.secondary)
        }
        CommandText(command: "stim gc")
      } else {
        Text("Needs a stim version with gc --json.").foregroundStyle(Palette.secondary)
      }
    }
    .font(.stim(.callout))
    .foregroundStyle(Palette.text)
    .padding(Space.xl)
    .frame(width: 340)
    .background(Palette.sidebar)
  }
}

enum InspectorPresentation {
  case column
  case overlay
  case hidden
}

struct InspectorToggleButton: View {
  var isShown: Bool
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      Label(isShown ? "Hide Inspector" : "Show Inspector", systemImage: "sidebar.right")
    }
    .help(isShown ? "Hide the inspector" : "Show the inspector")
  }
}

/// Shows or hides the workspace's logs below its devices, with the error count while they are hidden.
struct LogsToggleButton: View {
  var isShown: Bool
  var errors: Int
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      Label(isShown ? "Hide Logs" : "Show Logs", systemImage: "text.alignleft")
    }
    .overlay(alignment: .topTrailing) {
      if errors > 0, !isShown {
        Text(errors > 99 ? "99+" : String(errors))
          .font(.system(size: 9, weight: .bold))
          .monospacedDigit()
          .foregroundStyle(.white)
          .padding(.horizontal, 4)
          .frame(minWidth: 15, minHeight: 15)
          .background(Capsule().fill(Palette.error))
          .offset(x: 6, y: -5)
          .allowsHitTesting(false)
      }
    }
    .help(
      isShown
        ? "Hide the logs"
        : errors > 0 ? "Show the logs: \(countLabel(errors, "error")) since the last marker" : "Show the logs"
    )
    .accessibilityLabel(isShown ? "Hide logs" : errors > 0 ? "Show logs, \(countLabel(errors, "error"))" : "Show logs")
  }
}

struct InspectorToggle {
  var isShown: Bool
  var toggle: () -> Void
}

struct SidebarNavigation {
  var go: (SidebarItem) -> Void
}

extension FocusedValues {
  @Entry var inspectorToggle: InspectorToggle?
  @Entry var sidebarNavigation: SidebarNavigation?
}

extension EnvironmentValues {
  /// The main window's content size, which caps the size of a sheet over it.
  @Entry var windowSize = CGSize.zero
}

/// Presents the setup guide over the main window, and opens it when the Help menu or Settings asks.
private struct SetupGuidePresenter: ViewModifier {
  @ObservedObject var onboarding: Onboarding
  let actions: ActionCenter
  @ObservedObject private var openRequests = OpenRequests.shared

  func body(content: Content) -> some View {
    content
      .sheet(isPresented: $onboarding.showsGuide) {
        SetupGuideView(onboarding: onboarding).environmentObject(actions)
      }
      .onQuitRequested { onboarding.showsGuide = false }
      .onChange(of: openRequests.showsSetupGuide, initial: true) { _, shows in
        guard shows else { return }
        openRequests.showsSetupGuide = false
        onboarding.openGuide()
      }
  }
}
