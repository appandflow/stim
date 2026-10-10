import Combine
import StimKit
import StimStores
import SwiftUI

enum SidebarItem: Hashable {
  case overview
  case wall
  case project(Project)
  case environment(String)
  case archived(String)
  case worktree(String)
  case notifications
  case machine

  var logName: String {
    switch self {
    case .overview: "overview"
    case .wall: "wall"
    case .archived(let id): "archived \(id)"
    case .project(let project): "project \(project.root)"
    case .environment(let path): "workspace \(path)"
    case .worktree(let path): "worktree \(path)"
    case .notifications: "notifications"
    case .machine: "machine"
    }
  }
}

struct RootView: View {
  @ObservedObject private var store: StatusStore
  private let metrics: MetricsStore
  private let gc: GcReportStore
  @ObservedObject private var tips: TipCoordinator
  private let buildMachines: BuildMachinesModel
  @ObservedObject private var actions: ActionCenter
  @ObservedObject private var operations: OperationLog
  @ObservedObject private var inbox = NotificationInbox.shared
  private let autopilot: AutopilotRunner
  private let onboarding: Onboarding
  private let storage: StorageStore
  private let planChecks: BuildPlanChecks
  private let statsReader: StatsReader
  @StateObject private var tutorial = TutorialModel()
  @State private var selection: SidebarItem? = .overview
  @State private var previousSelection: SidebarItem? = .overview
  @StateObject private var navigation = NavigationController()
  @State private var replacesHistory = false
  @State private var restoredProject = false
  @State private var lastResolvedWorkspace: String?
  @AppStorage(AppPreferences.Key.defaultView) private var defaultView = DefaultView.overview
  @AppStorage(AppPreferences.Key.lastProjectPath) private var lastProjectPath = ""
  @State private var projectFilter: Project?
  @State private var showingAllWorktrees: Project?
  @State private var focusedDeviceID: String?
  @State private var logQuery = LogQuery()
  @State private var archivedLogQuery = LogQuery()
  @AppStorage(AppPreferences.Key.showsLogs) private var showsLogs = false
  @AppStorage(AppPreferences.Key.showsInspector) private var showsInspector = true
  @State private var showsInspectorOverlay = false
  @State private var inspectorWidth = WorkspaceDetail.inspectorWidth
  @State private var windowSize = CGSize.zero
  @State private var sidebarWidth: CGFloat = 0
  @State private var settledInspectorFits: Bool?
  @State private var detailWidth: CGFloat = 0
  @State private var narrowestSummaryWidth: CGFloat = .infinity
  @State private var summaryHidden = true
  @State private var logWorkspacePath: String?
  @State private var columnVisibility = NavigationSplitViewVisibility.all
  @ObservedObject private var nativePermissions = NativeViewerPermissions.shared
  @ObservedObject private var openRequests = OpenRequests.shared
  private let toasts = ToastCenter.shared
  private let notices = NoticeCenter.shared
  @AppStorage(AppPreferences.Key.dismissedStimUpdate) private var dismissedStimUpdate = ""
  @State private var pendingLink: PendingWorkspaceLink?
  @Environment(\.openWindow) private var openWindow
  @Environment(\.openSettings) private var openSettings
  @AppStorage("settingsTab") private var settingsTab = "app"

  private let cli: Task<StimCLI, Never>
  private let tutorialClock = Timer.publish(every: 5, on: .main, in: .common).autoconnect()

  init(
    cli: Task<StimCLI, Never>, store: StatusStore, actions: ActionCenter, autopilot: AutopilotRunner,
    onboarding: Onboarding, gc: GcReportStore, buildMachines: BuildMachinesModel, metrics: MetricsStore,
    storage: StorageStore, planChecks: BuildPlanChecks, statsReader: StatsReader, tips: TipCoordinator
  ) {
    self.tips = tips
    self.buildMachines = buildMachines
    self.cli = cli
    self.onboarding = onboarding
    self.store = store
    self.actions = actions
    operations = actions.operations
    self.autopilot = autopilot
    self.gc = gc
    self.metrics = metrics
    self.storage = storage
    self.planChecks = planChecks
    self.statsReader = statsReader
  }

  var body: some View {
    NavigationSplitView(columnVisibility: $columnVisibility) {
      Sidebar(
        store: store, autopilot: autopilot, onboarding: onboarding, actions: actions, selection: attributed(.click("sidebar")),
        openLogs: showLogs,
        tips: tips
      )
      .toolbar(removing: .sidebarToggle)
      .toolbar {
        if columnVisibility != .detailOnly { sidebarToggleToolbar }
      }
      .navigationSplitViewColumnWidth(min: 220, ideal: 272, max: 360)
      .onGeometryChange(for: CGFloat.self) {
        $0.size.width
      } action: {
        sidebarWidth = $0
      }
    } detail: {
      HStack(spacing: 0) {
        detail.frame(maxWidth: .infinity, maxHeight: .infinity)
        if tutorial.isOpen, let snapshot = tutorial.snapshot {
          Rectangle().fill(Palette.border).frame(width: 1).ignoresSafeArea(edges: .top)
          TutorialPanel(
            snapshot: snapshot, message: tutorial.notice,
            issues: tutorial.workspace?.issues ?? [], phoneState: tutorial.phoneState,
            canRunIOS: tutorial.workspace.map { $0.build?.isRunning != true && actions.active(for: $0.path) == nil } ?? false,
            agentDeviceMissing: tutorial.workspace?.agentDevice?.installed == false,
            asks: tutorial.ask, commands: tutorial.commands,
            copied: { tutorial.copiedPrompt() }, skip: tutorial.skip, markDone: tutorial.markDone,
            restart: tutorial.restart,
            runIOS: {
              if let workspace = tutorial.workspace {
                actions.run(
                  "Run \(workspace.names.title) on iOS",
                  steps: [
                    StimCommand(["ios", "--remote", "local", "--remote-build", "local"], cwd: workspace.path)
                  ], present: false)
              }
            },
            close: tutorial.close,
            openArchived: openTutorialArchive,
            pairPhone: { openRequests.pairsPhone = true },
            updateCLI: {
              onboarding.openGuide()
              onboarding.guideStep = .cli
            }
          )
          .frame(width: WorkspaceDetail.inspectorWidth)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Palette.background)
      .overlay(alignment: .bottom) { onboardingPopup }
      .background(alignment: .topLeading) {
        machineSummary(measuresNarrowest: true)
          .onGeometryChange(for: CGFloat.self) {
            $0.size.width
          } action: {
            narrowestSummaryWidth = $0
          }
          .hidden()
      }
      .overlay(alignment: .topTrailing) { inspectorSideControls }
      .overlay(alignment: .topTrailing) { ToastStack(center: toasts) }
      .overlay(alignment: .bottomLeading) { NoticeStack(center: notices) }
      .onGeometryChange(for: CGFloat.self) {
        $0.size.width
      } action: {
        detailWidth = $0
      }
      .navigationSplitViewColumnWidth(min: tutorial.isOpen ? WorkspaceDetail.widthWithInspector : 440, ideal: 900)
      .toolbar {
        if columnVisibility == .detailOnly { sidebarToggleToolbar }
        let history = HistoryButtons(
          navigation: navigation, canGoBack: navigation.canGoBack, canGoForward: navigation.canGoForward)
        if #available(macOS 26.0, *) {
          ToolbarItem(placement: .navigation) {
            history.padding(.horizontal, Space.xs).frame(height: ToolbarMetrics.glassHeight)
              .glassEffect(.regular, in: Capsule())
          }
          .sharedBackgroundVisibility(.hidden)
          ToolbarSpacer(.fixed, placement: .navigation)
        } else {
          ToolbarItem(placement: .navigation) { history }
        }
        if columnVisibility == .detailOnly, !operations.runs.isEmpty {
          ToolbarItem(placement: .navigation) {
            OperationsButton(log: operations, actions: actions, store: store, arrowEdge: .bottom)
          }
        }
        let summary = machineSummary()
        if summary.hasContent, summaryFits {
          let summaryItem =
            summary
            .frame(maxWidth: max(0, summaryWidth), alignment: .leading)
            .frame(height: ToolbarMetrics.glassHeight)
          if #available(macOS 26.0, *) {
            ToolbarItem(id: summaryItemID(for: summary), placement: .navigation) {
              summaryItem.glassEffect(.regular, in: Capsule())
            }
            .sharedBackgroundVisibility(.hidden)
          } else {
            ToolbarItem(id: summaryItemID(for: summary), placement: .navigation) { summaryItem }
          }
        }
        ToolbarItem(placement: .primaryAction) { Spacer() }
        if !controlsBesideInspector {
          let bell = notificationButton.padding(.horizontal, Space.xs).frame(height: ToolbarMetrics.glassHeight)
          if #available(macOS 26.0, *) {
            ToolbarItem(id: "notifications", placement: .primaryAction) {
              bell.glassEffect(.regular, in: Capsule())
            }
            .sharedBackgroundVisibility(.hidden)
          } else {
            ToolbarItem(id: "notifications", placement: .primaryAction) { notificationButton }
          }
          if showsWorkspace, #available(macOS 26.0, *) {
            ToolbarSpacer(.fixed, placement: .primaryAction)
          }
        }
        if showsWorkspace {
          let controls = HStack(spacing: Space.md) {
            logsToggleButton
            InspectorToggleButton(isShown: inspector != .hidden, action: toggleInspector)
          }
          .padding(.horizontal, Space.md + Space.xxs)
          .frame(height: ToolbarMetrics.glassHeight)
          .accessibilityElement(children: .contain)
          if #available(macOS 26.0, *) {
            ToolbarItem(placement: .primaryAction) {
              controls.glassEffect(.regular, in: Capsule()).padding(.trailing, Space.md)
            }
            .sharedBackgroundVisibility(.hidden)
          } else {
            ToolbarItem(placement: .primaryAction) { controls.padding(.trailing, Space.md) }
          }
        }
      }
    }
    .onChange(of: [summaryWidth, narrowestSummaryWidth], initial: true) {
      summaryHidden = !summaryFits
    }
    .tutorialHighlights()
    .environment(\.tutorialHint, tutorialHint)
    .focusedSceneValue(
      \.inspectorToggle,
      showsWorkspace || tutorial.isOpen
        ? InspectorToggle(isShown: inspector != .hidden || tutorial.isOpen, toggle: toggleInspector) : nil
    )
    .focusedSceneValue(
      \.sidebarNavigation, SidebarNavigation { navigate($0, .command("Overview, Active Workspaces, Notifications or Machines")) }
    )
    .focusedSceneValue(
      \.historyNavigation,
      HistoryNavigation(
        canGoBack: navigation.canGoBack, canGoForward: navigation.canGoForward, back: { navigation.goBack(via: .menu) },
        forward: { navigation.goForward(via: .menu) })
    )
    .onChange(of: destination) { _, destination in
      if replacesHistory {
        replacesHistory = false
        navigation.replaceCurrent(destination)
      } else {
        navigation.record(destination)
      }
    }
    .onChange(of: inspectorFits) { showsInspectorOverlay = false }
    .task(id: [windowSize.width, detailRoom]) { await settleInspectorFit() }
    .onGeometryChange(for: CGSize.self) {
      $0.size
    } action: {
      windowSize = $0
    }
    .environment(\.windowSize, windowSize)
    .toolbarBackground(.hidden, for: .windowToolbar)
    .tint(Palette.primary)
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
    .sheet(isPresented: $nativePermissions.showsSetup) {
      NativeViewerPermissionsView(
        permissions: nativePermissions, relaunch: onboarding.canRelaunch ? { onboarding.relaunch() } : nil)
    }
    .modifier(TutorialRestartDialogs(tutorial: tutorial))
    .onAppear {
      navigation.resolves = resolves
      navigation.apply = show
      navigation.startMonitoring()
      store.start()
      tutorial.configure(cli: cli)
      openRequests.openMainWindow = { [openWindow] in openWindow(id: "main") }
    }
    .onDisappear {
      notices.removeAll()
      navigation.stopMonitoring()
      navigation.resolves = { _ in true }
      navigation.apply = { _ in }
    }
    .onChange(of: onboarding.stimUpdate, initial: true) { _, latest in showStimUpdate(latest) }
    .onChange(of: onboarding.showsGuide || tutorial.isOpen, initial: true) { _, suppressed in tips.suppressed = suppressed }
    .onChange(of: openRequests.target, initial: true) { _, target in show(target, in: store.payload) }
    .onReceive(openRequests.$addMachine) { request in
      guard request != nil else { return }
      settingsTab = "build-machines"
      openSettings()
    }
    .onReceive(openRequests.$pairsPhone) { pair in
      guard pair else { return }
      guard PhoneApp.opensPairing(phoneApp: FeatureFlags.isEnabled(.phoneApp)) else {
        openRequests.pairsPhone = false
        return
      }
      settingsTab = "phones"
      openSettings()
    }
    .onReceive(openRequests.$device) { request in showDevice(request, in: store.payload) }
    .onReceive(openRequests.$workspaceLink) { link in
      guard link != nil else { return }
      Task { takeWorkspaceLink() }
    }
    .onReceive(store.$payload) { payload in
      updateTutorial(payload)
      if let payload {
        notices.dismissCards(notIn: payload)
        toasts.dismissCards(notIn: payload)
      }
      showDevice(openRequests.device, in: payload)
      showWorkspaceLink(in: payload)
      show(openRequests.target, in: payload)
      if case .worktree(let path) = selection,
        let environment = payload?.environments.filter({ $0.path == path || $0.worktree?.path == path }).map(\.path)
          .sorted().first
      {
        navigate(.environment(environment), .automatic("worktree now has a workspace"))
      }
      restoreLastProject()
    }
    .onReceive(openRequests.$tutorialRequest) { entry in
      guard let entry else { return }
      openRequests.tutorialRequest = nil
      tutorial.open(beginning: entry == .begin)
    }
    .onReceive(tutorialClock) { _ in
      updateTutorial(store.payload)
    }
    .onReceive(TutorialViewerEvents.shared.$events) { events in updateTutorial(store.payload, events: events) }
    .onReceive(store.$projects) { _ in restoreLastProject() }
    .onReceive(openRequests.$showsMachine) { shows in
      guard shows else { return }
      openRequests.showsMachine = false
      navigate(.machine, .request("show machine"))
    }
    .onReceive(openRequests.$workspacePath) { path in
      guard let path else { return }
      openRequests.workspacePath = nil
      navigate(.environment(path), .request("workspace path"))
    }
    .onReceive(store.$payload) { payload in
      if let payload, case .environment(let path) = selection {
        if WorktreePage(path: path, environments: payload.environments) != nil {
          lastResolvedWorkspace = path
        } else if lastResolvedWorkspace == path
          || WorktreePage(path: path, environments: store.payload?.environments ?? []) != nil,
          let archive = ArchivedWorkspace.newest(removedFrom: path, in: payload.archived ?? [])
        {
          lastResolvedWorkspace = nil
          navigate(.archived(archive.id), .automatic("workspace removed, opening its archive"))
          return
        }
      }
      guard let payload, case .archived(let id) = selection,
        !(payload.archived ?? []).contains(where: { $0.id == id })
      else { return }
      navigate(previousSelection ?? .overview, .automatic("archived workspace no longer listed"))
    }
    .onChange(of: selection, initial: true) { old, item in
      let name = item?.logName ?? "none"
      let cause = navigation.takeCause()
      if old == item {
        DebugLog.setDestination(name)
      } else {
        DebugLog.setDestination(name, from: old?.logName ?? "none", cause: cause)
      }
    }
    .onChange(of: selection) { old, item in
      if case .archived = item {
        archivedLogQuery = LogQuery()
        if case .archived = old {} else { previousSelection = old }
      }
      if case .environment(let path) = item, path == lastResolvedWorkspace {} else { lastResolvedWorkspace = nil }
      restoredProject = true
      if case .project = item {} else { showingAllWorktrees = nil }
      switch item {
      case .overview, .wall:
        projectFilter = nil
        openRequests.selectedWorkspace = nil
      case .project(let project):
        if showingAllWorktrees != project { showingAllWorktrees = nil }
        projectFilter = project
        lastProjectPath = project.root
        openRequests.selectedWorkspace = store.environments(in: project).first?.path
      case .environment(let path):
        openRequests.selectedWorkspace = path
      case .worktree, .archived:
        openRequests.selectedWorkspace = nil
      default: break
      }
    }
  }

  private var tutorialHint: TutorialHint? {
    guard tutorial.isOpen else { return nil }
    let selected: String? = if case .environment(let path) = selection { path } else { nil }
    return TutorialHint(
      step: tutorial.snapshot?.currentStep ?? "done", path: tutorial.tourPath, selectedPath: selected,
      showMe: {
        if tutorial.snapshot?.isFinished == true {
          openTutorialArchive()
        } else if let path = tutorial.tourPath {
          navigate(.environment(path), .click("tutorial Show me"))
          if ["logs", "refresh", "agent"].contains(tutorial.snapshot?.currentStep ?? "") { showsLogs = true }
        }
      })
  }

  private func updateTutorial(_ payload: StatusPayload?, events: [TutorialViewerEvents.Entry]? = nil) {
    guard let payload else { return }
    tutorial.update(
      workspaces: payload.environments, archived: payload.archived ?? [],
      sheetOpen: onboarding.showsGuide || nativePermissions.showsSetup || actions.presented != nil
        || NSApp.windows.contains { $0.attachedSheet != nil },
      viewerEvents: events ?? TutorialViewerEvents.shared.events,
      pairedPhoneCount: ServerController.shared.pairedPhoneCount,
      removalRefused: operations.runs.contains { run in
        run.needsAttention && run.startedAt >= (tutorial.snapshot?.record.stepSince ?? .distantFuture)
          && run.steps.contains { command in
            command.arguments.starts(with: ["worktree", "remove"])
              && (command.cwd == tutorial.tourPath || command.arguments.contains(tutorial.tourPath ?? ""))
          }
      })
  }

  private func openTutorialArchive() {
    if let archive = ArchivedWorkspace.newest(removedFrom: tutorial.tourPath ?? "", in: store.payload?.archived ?? []) {
      navigate(.archived(archive.id), .click("tutorial Show me"))
    }
  }

  private var showsWorkspace: Bool {
    if case .environment = selection { return selectedPage != nil }
    if case .archived = selection { return true }
    return false
  }

  private var selectedPage: WorktreePage? {
    guard case .environment(let path) = selection else { return nil }
    return WorktreePage(path: path, environments: store.payload?.environments ?? [])
  }

  private var logsWorkspace: Binding<String?> {
    Binding(
      get: { logWorkspacePath },
      set: { path in
        if selectedPage?.isUnified == true, logWorkspacePath != path {
          logQuery.slot = nil
          logQuery.buildRun = nil
        }
        logWorkspacePath = path
      })
  }

  private var detailRoom: CGFloat {
    windowSize.width - (columnVisibility == .detailOnly ? 0 : sidebarWidth)
  }

  private var inspectorFits: Bool {
    settledInspectorFits ?? (detailRoom >= WorkspaceDetail.widthWithInspector)
  }

  private func settleInspectorFit() async {
    let fits = detailRoom >= WorkspaceDetail.widthWithInspector
    guard windowSize.width > 0, columnVisibility == .detailOnly || sidebarWidth > 0, settledInspectorFits != fits else {
      return
    }
    if fits, settledInspectorFits != nil {
      try? await Task.sleep(for: .milliseconds(150))
      if Task.isCancelled { return }
    }
    settledInspectorFits = fits
  }

  private var inspector: InspectorPresentation {
    if tutorial.isOpen { return .hidden }
    if inspectorFits { return showsInspector ? .column : .hidden }
    return showsInspectorOverlay ? .overlay : .hidden
  }

  private var workspaceTitles: WorkspaceTitles {
    WorkspaceTitles(
      titles: Dictionary(
        (store.payload?.environments ?? []).map { ($0.path, $0.names.title) }, uniquingKeysWith: { first, _ in first }))
  }

  private func toggleInspector() {
    if tutorial.isOpen {
      tutorial.close()
      if inspectorFits { showsInspector = true } else { showsInspectorOverlay = true }
      return
    }
    if inspectorFits { showsInspector.toggle() } else { showsInspectorOverlay.toggle() }
  }

  /// Leaves room for the inspector, column or floating, so the popup never sits under it.
  @ViewBuilder private var onboardingPopup: some View {
    HStack(spacing: 0) {
      OnboardingBanner(onboarding: onboarding).frame(maxWidth: .infinity)
      if tutorial.isOpen {
        Color.clear.frame(width: WorkspaceDetail.inspectorWidth + 1)
      } else if showsWorkspace, inspector == .column {
        Color.clear.frame(width: WorkspaceDetail.clampedInspectorWidth(inspectorWidth, detailWidth: detailWidth) + 1)
      } else if showsWorkspace, inspector == .overlay {
        Color.clear.frame(width: WorkspaceDetail.inspectorWidth)
      }
    }
  }

  private var controlsBesideInspector: Bool { showsWorkspace && inspector == .column }

  @ToolbarContentBuilder private var sidebarToggleToolbar: some ToolbarContent {
    if #available(macOS 26.0, *) {
      ToolbarItem(placement: .navigation) {
        sidebarToggleButton.glassEffect(.regular, in: Capsule())
      }
      .sharedBackgroundVisibility(.hidden)
    } else {
      ToolbarItem(placement: .navigation) {
        sidebarToggleButton.background(.regularMaterial, in: Capsule())
      }
    }
  }

  private var sidebarToggleButton: some View {
    Button {
      withAnimation { columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly }
    } label: {
      Label(columnVisibility == .detailOnly ? "Show Sidebar" : "Hide Sidebar", systemImage: "sidebar.left")
    }
    .buttonStyle(.icon())
    .labelStyle(.iconOnly)
    .padding(.horizontal, Space.md + Space.xxs)
    .frame(height: ToolbarMetrics.glassHeight)
    .help(columnVisibility == .detailOnly ? "Show the sidebar" : "Hide the sidebar")
  }

  private var logsToggleButton: some View {
    LogsToggleButton(isShown: showsLogs, errors: selectedPage?.errors ?? 0) {
      if !showsLogs, let page = selectedPage, page.isUnified, let app = page.soleErrorApp {
        logsWorkspace.wrappedValue = app.path
      }
      showsLogs.toggle()
    }
  }

  @ViewBuilder private var inspectorSideControls: some View {
    if controlsBesideInspector {
      let controls = notificationButton.padding(.horizontal, Space.xs).frame(height: ToolbarMetrics.glassHeight)
      Group {
        if #available(macOS 26.0, *) {
          controls.glassEffect(.regular, in: Capsule())
        } else {
          controls.background(.regularMaterial, in: Capsule())
        }
      }
      .padding(.top, 6)
      .padding(.trailing, WorkspaceDetail.clampedInspectorWidth(inspectorWidth, detailWidth: detailWidth) + 1 + Space.lg)
      .ignoresSafeArea(edges: .top)
    }
  }

  private var notificationButton: some View {
    let unread = inbox.inbox.unreadCount
    return Button {
      navigate(.notifications, .click("notifications button"))
    } label: {
      NotificationBell(selected: selection == .notifications)
        .padding(.trailing, unread > 0 ? 6 : 0)
        .frame(width: Self.bellContentWidth(unread: unread), height: 36)
        .overlay(alignment: .topTrailing) {
          if unread > 0 {
            Text(unread > 99 ? "99+" : "\(unread)")
              .font(.system(size: 9, weight: .bold))
              .monospacedDigit()
              .foregroundStyle(.white)
              .fixedSize()
              .padding(.horizontal, 4)
              .frame(minWidth: 15, minHeight: 15)
              .background(Capsule().fill(Palette.brand))
              .padding(.top, 3)
              .padding(.trailing, 5)
              .allowsHitTesting(false)
          }
        }
        .contentShape(Capsule())
    }
    .buttonStyle(.hoverRow(radius: Radius.round, selected: selection == .notifications))
    .accessibilityLabel("Notifications")
    .accessibilityValue("\(inbox.inbox.unreadCount) unread")
    .help("Open notifications")
  }

  private static func bellContentWidth(unread: Int) -> CGFloat {
    unread == 0 ? 32 : unread < 10 ? 40 : 46
  }

  private var bellWidth: CGFloat {
    Self.bellContentWidth(unread: inbox.inbox.unreadCount) + 2 * Space.xs + Self.toolbarItemSpacing
  }

  private static let toolbarItemSpacing: CGFloat = 16
  private static let toolbarSlack: CGFloat = 16
  private static let summaryHysteresis: CGFloat = 8
  private static let historyButtonsWidth: CGFloat = 64
  private static let operationsButtonWidth: CGFloat = 64

  /// macOS moves the traffic lights and the sidebar toggle into the detail's toolbar when the sidebar is hidden.
  private var summaryWidth: CGFloat {
    detailWidth - (columnVisibility == .detailOnly ? 200 : 80) - Self.toolbarSlack
      - (showsWorkspace && inspector != .column ? 88 : 0)
      - bellWidth
      - Self.historyButtonsWidth
      - (columnVisibility == .detailOnly && !operations.runs.isEmpty ? Self.operationsButtonWidth : 0)
      - (tutorial.isOpen ? WorkspaceDetail.inspectorWidth + 1 : 0)
      - (showsWorkspace && inspector == .column
        ? WorkspaceDetail.clampedInspectorWidth(inspectorWidth, detailWidth: detailWidth) + 1
        : showsWorkspace && inspector == .overlay ? max(0, WorkspaceDetail.inspectorWidth - 88 - bellWidth) : 0)
  }

  private func machineSummary(measuresNarrowest: Bool = false) -> MachineSummary {
    MachineSummary(store: store, metrics: metrics, gc: gc, width: summaryWidth, measuresNarrowest: measuresNarrowest) {
      navigate(.machine, .click("machine summary"))
    }
  }

  private var summaryFits: Bool {
    summaryWidth >= narrowestSummaryWidth + (summaryHidden ? Self.summaryHysteresis : 0)
  }

  /// NSToolbar measures an item when it is inserted or the window resizes, not when a SwiftUI item grows, so the
  /// summary is reinserted whenever the room it gets changes.
  private func summaryItemID(for summary: MachineSummary) -> String {
    "machine-summary-\(summary.contentKey)-\(detailWidth > 0)-\(tutorial.isOpen)-\(showsWorkspace)-\(showsWorkspace && inspector == .column)-\(showsWorkspace && inspector == .overlay)-\(bellWidth)-\(summaryFits)"
  }

  private func restoreLastProject() {
    guard !restoredProject, selection == .overview else { return }
    if defaultView == .allDevices {
      restoredProject = true
      replacesHistory = true
      navigate(.wall, .automatic("default view"))
      return
    }
    guard defaultView == .lastProject, !lastProjectPath.isEmpty else { return }
    guard let entry = store.projectList.first(where: { $0.project.root == lastProjectPath }) else { return }
    restoredProject = true
    replacesHistory = true
    navigate(.project(entry.project), .automatic("default view"))
  }

  private var destination: NavigationDestination {
    var showsAll = false
    if case .project(let project) = selection { showsAll = showingAllWorktrees == project }
    var focused: String?
    if case .environment = selection { focused = focusedDeviceID }
    return NavigationDestination(selection: selection, showsAllWorktrees: showsAll, focusedDeviceID: focused)
  }

  private func navigate(_ item: SidebarItem?, _ cause: NavigationCause) {
    navigation.setCause(cause)
    selection = item
  }

  private func attributed(_ cause: NavigationCause) -> Binding<SidebarItem?> {
    Binding(get: { selection }, set: { navigate($0, cause) })
  }

  private func show(_ destination: NavigationDestination) {
    selection = destination.selection
    showingAllWorktrees = nil
    if destination.showsAllWorktrees, case .project(let project)? = destination.selection { showingAllWorktrees = project }
    focusedDeviceID = destination.focusedDeviceID
  }

  /// Whether the destination's page still exists. Without a status payload nothing can be told yet.
  private func resolves(_ destination: NavigationDestination) -> Bool {
    guard let payload = store.payload else { return true }
    switch destination.selection {
    case .environment(let path): return WorktreePage(path: path, environments: payload.environments) != nil
    case .worktree(let path): return payload.unprovisionedWorktrees?.contains { $0.path == path } == true
    case .archived(let id): return payload.archived?.contains { $0.id == id } == true
    case .project(let project): return store.projectList.contains { $0.project == project }
    default: return true
    }
  }

  /// `@Published` emits before the property changes, so both values arrive as arguments.
  private func showDevice(_ request: DeviceOpenRequest?, in payload: StatusPayload?) {
    guard let request, let owner = payload?.owner(of: request) else { return }
    openRequests.device = nil
    let path = owner.workspace.path
    let deviceID = owner.device.id
    notices.show(
      Notice(
        icon: "iphone", title: "\(owner.device.label) launched for \(owner.workspace.names.title)",
        detail: abbreviatingHome(path), actionTitle: "Show",
        perform: {
          navigate(.environment(path), .click("device launch notice"))
          focusedDeviceID = deviceID
        }, key: "device-launch:\(deviceID)", workspacePath: path))
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
  /// since `stim status --watch` can lag the command that printed the link. A link without `archive=` opens the
  /// path's newest archive only after that wait, so a re-created worktree is not shadowed by its old archive.
  private func showWorkspaceLink(in payload: StatusPayload?) {
    guard let pending = pendingLink, let payload else { return }
    guard let target = payload.target(of: pending.request) else {
      if let archive = payload.archive(for: pending.request, waited: pending.waited) {
        pendingLink = nil
        navigate(.archived(archive.id), .request("workspace link"))
        return
      }
      guard !pending.expiring else { return }
      pendingLink?.expiring = true
      Task {
        try? await Task.sleep(for: .seconds(10))
        guard pendingLink?.id == pending.id else { return }
        pendingLink?.waited = true
        if let archive = store.payload?.archive(for: pending.request, waited: true) {
          pendingLink = nil
          navigate(.archived(archive.id), .request("workspace link"))
          return
        }
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
          navigate(.environment(path), .click("workspace started toast"))
          if let deviceID { focusedDeviceID = deviceID }
        },
        sticky: true, key: "workspace-link:\(path)", workspacePath: path))
  }

  private func showWorkspaceNotFound(_ body: String, key: String? = nil) {
    toasts.show(Toast(icon: "questionmark.folder", tone: .warning, title: "Workspace not found", body: body, key: key))
  }

  private func show(_ target: OversightTarget?, in payload: StatusPayload?) {
    guard let target, let payload else { return }
    let env = target.path.flatMap { path in payload.environments.first { $0.path == path } }
    openRequests.target = nil
    if env == nil, let path = target.path,
      let archive = ArchivedWorkspace.newest(removedFrom: path, in: payload.archived ?? [])
    {
      navigate(.archived(archive.id), .request("oversight target"))
      return
    }
    switch target {
    case .machine:
      navigate(.machine, .request("oversight target"))
    case .device(let path, let platform, let slot):
      navigate(.environment(path), .request("oversight target"))
      if let device = env?.devices.first(where: { device in
        if case .remote = device { return false }
        return device.platform == platform && device.slot == slot
      }) {
        focusedDeviceID = device.id
      }
    case .build(let path, _):
      navigate(.environment(path), .request("oversight target"))
      if inspector == .hidden { toggleInspector() }
    case .workspace(let path), .url(let path, _):
      navigate(.environment(path), .request("oversight target"))
    case .buildRequest(let id):
      BuildRequestPrompt.present(id: id)
    }
  }

  private func openErrors(_ path: String) {
    logsWorkspace.wrappedValue = path
    navigate(.environment(path), .click("open errors"))
    showsLogs = true
    logQuery.errorsOnly = true
  }

  private func showLogs(_ path: String) {
    logsWorkspace.wrappedValue = path
    navigate(.environment(path), .click("open logs"))
    showsLogs = true
  }

  @ViewBuilder private var detail: some View {
    switch selection {
    case .environment(let path):
      if let page = WorktreePage(path: path, environments: store.payload?.environments ?? []) {
        let host = WorkspaceDetailHost(
          statsReader: statsReader, cli: cli, page: page, selectedPath: path, metrics: metrics, machine: store.payload?.machine,
          reportsBundles: store.payload?.environments.contains { $0.metro?.bundle != nil } ?? false,
          inspector: inspector, inspectorWidth: $inspectorWidth, focusedID: $focusedDeviceID, logQuery: $logQuery,
          logWorkspacePath: logsWorkspace, archived: store.payload?.archived ?? [],
          selection: attributed(.click("workspace page"))
        )
        if page.isUnified {
          host.id(page.identity)
        } else {
          host
        }
      } else {
        EmptyState(
          title: "Workspace Gone", message: "stim status no longer reports this workspace.",
          actionTitle: "Go to Overview", action: { navigate(.overview, .click("workspace gone overview")) })
      }
    case .archived(let id):
      if let archive = store.payload?.archived?.first(where: { $0.id == id }) {
        WorkspaceDetail.archived(
          archive, cli: cli, statsReader: statsReader, environments: store.payload?.environments ?? [],
          inspector: inspector, inspectorWidth: $inspectorWidth, logQuery: $archivedLogQuery,
          openReplacement: { navigate(.environment($0), .click("archived workspace replacement")) }
        )
        .id(id)
      }
    case .worktree(let path):
      if let worktree = store.payload?.unprovisionedWorktrees?.first(where: { $0.path == path }) {
        NoEnvironmentDetail(
          worktree: worktree, cli: cli,
          apps: notSetUpApps(for: worktree, environments: store.payload?.environments ?? [], project: store.project(ofPath:)),
          projectName: store.title(of: store.project(ofPath: worktree.path)))
      } else {
        EmptyState(title: "Worktree Gone", message: "stim status no longer reports this worktree.")
      }
    case .notifications:
      InboxView(inbox: NotificationInbox.shared, openLogs: openErrors)
    case .machine:
      MachineView(
        buildMachines: buildMachines, status: store, metrics: metrics, gc: gc, storage: storage, autopilot: autopilot, tips: tips)
    case .overview:
      OverviewView(
        store: store, metrics: metrics,
        selection: attributed(.click("overview page")),
        openLogs: openErrors,
        openDevice: { path, deviceID in
          focusedDeviceID = deviceID
          navigate(.environment(path), .click("overview page"))
        },
        openIdleProject: { project in
          showingAllWorktrees = project
          navigate(.project(project), .click("overview page"))
        })
    default:
      WallView(
        store: store, metrics: metrics, project: projectFilter,
        scope: projectFilter.map { ProjectPage.scope(of: $0, showingAll: showingAllWorktrees) } ?? .active,
        setScope: { showingAllWorktrees = $0 == .all ? projectFilter : nil },
        selection: attributed(.click("wall page")), openLogs: openErrors,
        openDevice: { path, deviceID in
          focusedDeviceID = deviceID
          navigate(.environment(path), .click("wall page"))
        })
    }
  }
}

private struct WorkspaceDetailHost: View {
  var statsReader: StatsReader
  var cli: Task<StimCLI, Never>
  var page: WorktreePage
  var selectedPath: String
  var metrics: MetricsStore
  var machine: MachineUsage?
  var reportsBundles: Bool
  var inspector: InspectorPresentation
  @Binding var inspectorWidth: CGFloat
  @Binding var focusedID: String?
  @Binding var logQuery: LogQuery
  @Binding var logWorkspacePath: String?
  var archived: [ArchivedWorkspace]
  @Binding var selection: SidebarItem?

  var body: some View {
    let env = page.apps[0]
    WorkspaceDetail(
      cli: cli, statsReader: statsReader, env: env, page: page, selectedPath: selectedPath, sampled: metrics.usage,
      usage: metrics.usage[env.path], machine: machine,
      reportsBundles: reportsBundles,
      history: metrics.owners, inspector: inspector, inspectorWidth: $inspectorWidth, focusedID: $focusedID,
      logQuery: $logQuery, logWorkspacePath: $logWorkspacePath, archived: archived, openArchive: { selection = .archived($0) })
  }
}

private struct PendingWorkspaceLink {
  let id = UUID()
  let request: WorkspaceOpenRequest
  var expiring = false
  var waited = false
}

private struct NotificationBell: View {
  var selected: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var wiggles = 0
  @State private var lastWiggle: Date?

  private struct Wiggle {
    var angle = 0.0
    var highlight = 0.0
  }

  var body: some View {
    let swing = reduceMotion ? 0.0 : 1.0
    return Image(systemName: "bell")
      .font(.system(size: 17))
      .keyframeAnimator(initialValue: Wiggle(), trigger: wiggles) { content, value in
        content
          .foregroundStyle(value.highlight > 0 ? Palette.primary : (selected ? Palette.primary : Palette.text))
          .rotationEffect(.degrees(value.angle * swing), anchor: .top)
      } keyframes: { _ in
        KeyframeTrack(\.angle) {
          CubicKeyframe(-12, duration: 0.1)
          CubicKeyframe(10, duration: 0.1)
          CubicKeyframe(-6, duration: 0.1)
          CubicKeyframe(0, duration: 0.1)
        }
        KeyframeTrack(\.highlight) {
          MoveKeyframe(1)
          LinearKeyframe(1, duration: 0.79)
          LinearKeyframe(0, duration: 0.01)
        }
      }
      .onReceive(NotificationInbox.shared.arrivals) { suppressed in
        let now = Date()
        guard
          Inbox.wigglesBell(suppressed: suppressed, notificationsOpen: selected, now: now, lastWiggle: lastWiggle)
        else { return }
        lastWiggle = now
        wiggles += 1
      }
  }
}

struct MachineSummary: View {
  @ObservedObject var store: StatusStore
  var metrics: MetricsStore
  var gc: GcReportStore
  var width: CGFloat
  var measuresNarrowest = false
  var openMachine: () -> Void
  @State private var expandedResource: ResourceKind?

  private func shows(_ resource: ResourceKind) -> Binding<Bool> {
    Binding(
      get: { expandedResource == resource },
      set: { if !$0, expandedResource == resource { expandedResource = nil } }
    )
  }

  @ViewBuilder private func popover(_ resource: ResourceKind) -> some View {
    switch resource {
    case .cpu: cpuPopover
    case .memory: memoryPopover
    case .disk: DiskPopover(metrics: metrics, gc: gc, openMachine: openMachine).presentationBackground(Palette.surface)
    }
  }

  /// macOS 26 draws a glass capsule around a toolbar item even when it draws nothing, so the item is declared only when `row` has content.
  var hasContent: Bool {
    store.error != nil || showsCPU || showsMemory || metrics.hasVolumes || (!store.watching && store.updatedAt != nil)
  }

  var contentKey: String {
    "\(store.error != nil)\(showsCPU)\(showsMemory)\(metrics.hasVolumes)\(!store.watching && store.updatedAt != nil)"
  }

  private var showsCPU: Bool { store.payload?.capacity != nil && metrics.totalCpuFraction != nil }
  private var showsMemory: Bool { store.payload?.capacity != nil && metrics.memory != nil }

  var body: some View {
    ProposedWidth(width: max(0, width)) {
      if measuresNarrowest {
        narrowestRow.fixedSize()
      } else {
        ViewThatFits(in: .horizontal) {
          row(showsCPU: true, showsMemory: true, showsBar: true, showsReclaimable: true)
          row(showsCPU: true, showsMemory: true, showsBar: true, showsReclaimable: false)
          row(showsCPU: true, showsMemory: true, showsBar: false, showsReclaimable: false)
          row(showsCPU: false, showsMemory: true, showsBar: false, showsReclaimable: false)
          narrowestRow
        }
      }
    }
    .font(.stim(.callout))
  }

  private var narrowestRow: some View {
    row(showsCPU: !metrics.hasVolumes, showsMemory: !metrics.hasVolumes, showsBar: false, showsReclaimable: false)
  }

  private func row(showsCPU includesCPU: Bool, showsMemory: Bool, showsBar: Bool, showsReclaimable: Bool) -> some View {
    HStack(spacing: Space.md) {
      if let error = store.error {
        Label(abbreviatingHome(error), systemImage: "exclamationmark.triangle.fill").foregroundStyle(Palette.warning)
          .lineLimit(1)
          .frame(maxWidth: 220)
          .help(abbreviatingHome(error))
      }
      let cap = store.payload?.capacity
      let cpu = cap == nil || !includesCPU ? nil : metrics.totalCpuFraction
      let memory = cap == nil || !showsMemory ? nil : metrics.memory
      let lowest = metrics.volumes.min(by: { $0.freeBytes < $1.freeBytes })
      ForEach(
        Array(ResourceSummary.entries(cpu: cpu != nil, memory: memory != nil, disk: lowest != nil).enumerated()),
        id: \.offset
      ) { _, entry in
        switch entry {
        case .divider:
          Rectangle().fill(Palette.secondary.opacity(0.3)).frame(width: 1, height: 16)
        case .item(.cpu):
          if let cpu { cpuItem(cpu) }
        case .item(.memory):
          if let memory, let cap { memoryItem(memory, cap: cap, showsBar: showsBar) }
        case .item(.disk):
          if let lowest { diskItem(lowest, showsReclaimable: showsReclaimable) }
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
    .padding(.horizontal, Space.lg)
    .padding(.vertical, Space.xs)
  }

  private func cpuItem(_ cpu: Double) -> some View {
    Button {
      expandedResource = .cpu
    } label: {
      statItem(
        icon: ResourceKind.cpu.icon, label: "CPU", value: formatPercent(cpu * 100), tone: UsageThresholds.cpu(fraction: cpu)
      )
      .padding(Space.sm)
    }
    .buttonStyle(.hoverRow(radius: Radius.round))
    .accessibilityLabel("CPU details")
    .accessibilityValue(formatPercent(cpu * 100))
    .help("CPU of every active workspace's processes, simulators and emulators, as a percent of this Mac's cores")
    .popover(isPresented: shows(.cpu), arrowEdge: .bottom) { popover(.cpu) }
    .onHover { hovering in
      if hovering, expandedResource != nil {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
          expandedResource = .cpu
        }
      }
    }
  }

  private func memoryItem(_ memory: MachineMemory, cap: Capacity, showsBar: Bool) -> some View {
    Button {
      expandedResource = .memory
    } label: {
      HStack(spacing: Space.sm) {
        statItem(
          icon: ResourceKind.memory.icon, label: "RAM",
          value: Format.memoryPair(usedBytes: memory.usedBytes, totalBytes: memory.totalBytes),
          tone: UsageThresholds.memory(memory.pressure))
        if showsBar {
          ProgressView(value: min(1, Double(memory.usedBytes) / Double(max(1, memory.totalBytes))))
            .tint(Color(UsageThresholds.memory(memory.pressure)))
            .frame(width: 50)
        }
      }
      .padding(Space.sm)
    }
    .buttonStyle(.hoverRow(radius: Radius.round))
    .accessibilityLabel("Memory details")
    .accessibilityValue(Format.memoryPair(usedBytes: memory.usedBytes, totalBytes: memory.totalBytes))
    .popover(isPresented: shows(.memory), arrowEdge: .bottom) { popover(.memory) }
    .onHover { hovering in
      if hovering, expandedResource != nil {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
          expandedResource = .memory
        }
      }
    }
    .help(
      "Memory used on this Mac, as Activity Monitor counts it. Stim's share: active workspaces \(store.payload?.machine?.memorySource == .footprint ? "use" : "commit") \(Format.gigabytes(mb: cap.committedMb)) of \(Format.gigabytes(mb: cap.totalMemoryMb))."
    )
  }

  private func diskItem(_ lowest: DiskVolume, showsReclaimable: Bool) -> some View {
    Button {
      expandedResource = .disk
    } label: {
      HStack(spacing: Space.sm) {
        statItem(
          icon: ResourceKind.disk.icon, label: "Disk", value: "\(Format.fileSize(lowest.freeBytes)) free",
          tone: UsageThresholds.disk(freeBytes: lowest.freeBytes))
        if showsReclaimable, let reclaimable = gc.report?.reclaimable, reclaimable.bytes > 0 {
          Text("\u{00B7} \(Format.fileSize(reclaimable.bytes)) reclaimable").foregroundStyle(Palette.secondary)
        }
      }
      .padding(Space.sm)
    }
    .buttonStyle(.hoverRow(radius: Radius.round))
    .accessibilityLabel("Disk details")
    .accessibilityValue("\(Format.fileSize(lowest.freeBytes)) free")
    .help("Free space on the fullest volume holding the repositories, Stim home or simulators, without purgeable space")
    .popover(isPresented: shows(.disk), arrowEdge: .bottom) { popover(.disk) }
    .onHover { hovering in
      if hovering, expandedResource != nil {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
          expandedResource = .disk
        }
      }
    }
  }

  private var cpuPopover: some View {
    MachineResourcePopover(title: "CPU", icon: "speedometer", openMachine: openMachine) {
      if let cpu = metrics.totalCpuFraction {
        Text(formatPercent(cpu * 100)).font(.stim(.title)).monospacedDigit()
        ProgressView(value: min(1, cpu)).tint(Color(UsageThresholds.cpu(fraction: cpu)))
        Text("Used by active workspaces' processes, simulators and emulators. 100% means all of this Mac's cores.")
          .foregroundStyle(Palette.secondary)
        if let cap = store.payload?.capacity {
          Text(countLabel(cap.liveCount, "active workspace")).foregroundStyle(Palette.tertiary)
        }
      }
    }
  }

  private var memoryPopover: some View {
    MachineResourcePopover(title: "Memory", icon: "memorychip", openMachine: openMachine) {
      if let memory = metrics.memory {
        Text("\(Format.memory(memory.usedBytes)) of \(Format.memory(memory.totalBytes))")
          .font(.stim(.headline)).monospacedDigit()
        Sparkline(values: metrics.memoryUsed, minimumPeak: Double(memory.totalBytes)).frame(height: 48)
        Text("Memory used on this Mac, as Activity Monitor counts it.").foregroundStyle(Palette.secondary)
        if let cap = store.payload?.capacity {
          Text(
            "Active workspaces \(store.payload?.machine?.memorySource == .footprint ? "use" : "commit") \(Format.gigabytes(mb: cap.committedMb))."
          )
          .foregroundStyle(Palette.secondary)
        }
      }
    }
  }

  private func statItem(icon: String, label: String, value: String, tone: Tone) -> some View {
    HStack(spacing: Space.sm) {
      Image(systemName: icon)
        .foregroundStyle(Palette.secondary)

      Text(label)
        .font(.stim(.caption))
        .foregroundStyle(Palette.secondary)

      Text(value)
        .font(.stim(.caption, mono: true))
        .fontWeight(.semibold)
        .foregroundStyle(Color(tone))
    }
    .fixedSize()
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
  var openMachine: () -> Void

  var body: some View {
    let volumes = metrics.volumes
    let reclaimable = gc.report?.reclaimable
    MachineResourcePopover(title: "Disk", icon: "internaldrive", openMachine: openMachine) {
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
  }
}

private struct MachineResourcePopover<Content: View>: View {
  var title: String
  var icon: String
  var openMachine: () -> Void
  @ViewBuilder var content: Content
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      VStack(alignment: .leading, spacing: Space.xxs) {
        Label(title, systemImage: icon).font(.stim(.headline))
        Text("This Mac").font(.stim(.caption)).foregroundStyle(Palette.tertiary)
      }
      content
      Rectangle().fill(Palette.border).frame(height: 1)
      Button("Open Machines", systemImage: "laptopcomputer") {
        dismiss()
        openMachine()
      }
      .buttonStyle(.stim())
    }
    .font(.stim(.callout))
    .foregroundStyle(Palette.text)
    .padding(Space.xl)
    .frame(width: 340)
    .background(Palette.surface)
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
    .buttonStyle(.icon(tint: isShown ? Palette.text : Palette.secondary))
    .labelStyle(.iconOnly)
    .accessibilityAddTraits(isShown ? .isSelected : [])
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
    .buttonStyle(.icon(tint: isShown ? Palette.text : Palette.secondary))
    .labelStyle(.iconOnly)
    .accessibilityAddTraits(isShown ? .isSelected : [])
    .overlay(alignment: .topTrailing) {
      if errors > 0, !isShown {
        Text(errors > 99 ? "99+" : String(errors))
          .font(.system(size: 9, weight: .bold))
          .monospacedDigit()
          .foregroundStyle(.white)
          .lineLimit(1)
          .fixedSize()
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
