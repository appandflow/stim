import StimKit
import SwiftUI

enum SidebarItem: Hashable {
  case wall
  case project(Project)
  case environment(String)
  case worktree(String)
  case notifications
  case attention
  case machine
}

struct RootView: View {
  @ObservedObject private var store: StatusStore
  @StateObject private var metrics: MetricsStore
  @ObservedObject private var actions: ActionCenter
  @ObservedObject private var autopilot: AutopilotRunner
  private let onboarding: Onboarding
  @StateObject private var storage: StorageStore
  @StateObject private var planChecks: BuildPlanChecks
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
  @State private var windowWidth: CGFloat = 0
  @State private var sidebarWidth: CGFloat = 0
  @State private var detailWidth: CGFloat = 0
  @State private var columnVisibility = NavigationSplitViewVisibility.all
  @ObservedObject private var openRequests = OpenRequests.shared
  @ObservedObject private var toasts = ToastCenter.shared
  @State private var pendingLink: PendingWorkspaceLink?
  @Environment(\.openWindow) private var openWindow

  private let cli: Task<StimCLI, Never>

  init(
    cli: Task<StimCLI, Never>, store: StatusStore, actions: ActionCenter, autopilot: AutopilotRunner,
    onboarding: Onboarding, gc: GcReportStore
  ) {
    self.cli = cli
    self.onboarding = onboarding
    self.store = store
    self.actions = actions
    self.autopilot = autopilot
    _metrics = StateObject(wrappedValue: MetricsStore(status: store, gc: gc))
    _storage = StateObject(wrappedValue: StorageStore(status: store, cli: cli))
    _planChecks = StateObject(
      wrappedValue: BuildPlanChecks { platform, workspace in
        try await cli.value.plan(platform: platform, workspace: workspace)
      })
  }

  var body: some View {
    NavigationSplitView(columnVisibility: $columnVisibility) {
      Sidebar(store: store, autopilot: autopilot, onboarding: onboarding, selection: $selection, openLogs: showLogs)
        .frame(minWidth: 220, idealWidth: 272, maxWidth: 360)
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
        .onGeometryChange(for: CGFloat.self) {
          $0.size.width
        } action: {
          detailWidth = $0
        }
        .navigationSplitViewColumnWidth(min: 440, ideal: 900)
        .toolbar {
          ToolbarItem(placement: .navigation) { ActivityToolbarIndicator(actions: actions) }
          ToolbarItem(id: summaryItemID, placement: .navigation) {
            MachineSummary(store: store, metrics: metrics, width: summaryWidth)
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
    .onChange(of: inspectorFits) { showsInspectorOverlay = false }
    .onGeometryChange(for: CGFloat.self) {
      $0.size.width
    } action: {
      windowWidth = $0
    }
    .toolbarBackground(.hidden, for: .windowToolbar)
    .tint(Palette.brand)
    .font(.stim(.body))
    .foregroundStyle(Palette.text)
    .environmentObject(actions)
    .environmentObject(planChecks)
    .sheet(item: $actions.presented) { run in
      ActivitySheet(run: run).environmentObject(actions)
    }
    .onAppear {
      store.start()
      metrics.start()
      openRequests.openMainWindow = { [openWindow] in openWindow(id: "main") }
    }
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
    windowWidth - (columnVisibility == .detailOnly ? 0 : sidebarWidth) >= WorkspaceDetail.widthWithInspector
  }

  private var inspector: InspectorPresentation {
    if inspectorFits { return showsInspector ? .column : .hidden }
    return showsInspectorOverlay ? .overlay : .hidden
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
    selection = .environment(owner.workspace.path)
    focusedDeviceID = owner.device.id
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
        WorkspaceDetail(
          cli: cli, env: env, usage: metrics.usage[env.path], machine: store.payload?.machine,
          reportsBundles: store.payload?.environments.contains { $0.metro?.bundle != nil } ?? false,
          history: metrics.owners, inspector: inspector,
          inspectorWidth: $inspectorWidth,
          focusedID: $focusedDeviceID, logQuery: $logQuery)
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
      InboxView(inbox: NotificationInbox.shared)
    case .attention:
      AttentionView(store: store, autopilot: autopilot, openLogs: openErrors)
    case .machine:
      MachineView(cli: cli, status: store, metrics: metrics, storage: storage, autopilot: autopilot)
    default:
      WallView(store: store, metrics: metrics, project: projectFilter, selection: $selection, openLogs: openErrors)
    }
  }
}

private struct PendingWorkspaceLink {
  let id = UUID()
  let request: WorkspaceOpenRequest
  var expiring = false
}

struct MachineSummary: View {
  @ObservedObject var store: StatusStore
  @ObservedObject var metrics: MetricsStore
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
        if let cpu = metrics.totalCpu {
          statItem(icon: "cpu", value: formatPercent(cpu), tone: UsageThresholds.cpu(fraction: metrics.totalCpuFraction))
            .help("CPU of every live workspace's processes, simulators and emulators, as a percent of one core")
        }
        if showsMemory, let memory = metrics.memory {
          HStack(spacing: Space.sm) {
            statItem(icon: "memorychip", value: formatMemoryPair(memory), tone: UsageThresholds.memory(memory.pressure))
            if showsBar {
              ProgressView(value: min(1, Double(memory.usedBytes) / Double(max(1, memory.totalBytes))))
                .tint(Theme.toneColor(UsageThresholds.memory(memory.pressure)))
                .frame(width: 50)
            }
          }
          .help(
            "Memory used on this Mac, as Activity Monitor counts it. Stim's share: live workspaces \(store.payload?.machine?.memorySource == .footprint ? "use" : "commit") \(formatGigabytes(mb: cap.committedMb)) of \(formatGigabytes(mb: cap.totalMemoryMb))."
          )
        }
      }
      if let lowest = metrics.volumes.min(by: { $0.freeBytes < $1.freeBytes }) {
        Button {
          showsDisk.toggle()
        } label: {
          HStack(spacing: Space.sm) {
            statItem(
              icon: "internaldrive", value: "\(formatDisk(lowest.freeBytes)) free",
              tone: UsageThresholds.disk(freeBytes: lowest.freeBytes))
            if showsReclaimable, let reclaimable = metrics.reclaimable, reclaimable.bytes > 0 {
              Text("\u{00B7} \(formatDisk(reclaimable.bytes)) reclaimable").foregroundStyle(Palette.primary)
            }
          }
        }
        .buttonStyle(.plain)
        .help("Free space on the fullest volume holding the repositories, Stim home or simulators, without purgeable space")
        .popover(isPresented: $showsDisk, arrowEdge: .bottom) {
          DiskPopover(volumes: metrics.volumes, reclaimable: metrics.reclaimable)
        }
      }
      if store.watching {
        Text("live")
          .font(.stim(.caption, mono: true))
          .foregroundStyle(Palette.tertiary)
          .help("stim status --watch reports each change as it happens")
      } else if let at = store.updatedAt {
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

  private func statItem(icon: String, value: String, tone: UsageTone) -> some View {
    HStack(spacing: Space.xs) {
      Image(systemName: icon)
      Text(value).font(.stim(.caption, mono: true)).fixedSize()
    }
    .foregroundStyle(Theme.toneColor(tone))
  }
}

private func formatMemoryPair(_ memory: MachineMemory) -> String {
  let used = formatGigabytes(mb: Int(memory.usedBytes >> 20)).replacingOccurrences(of: " GB", with: "")
  let totalGb = Int((Double(memory.totalBytes >> 20) / 1024).rounded())
  return "\(used)/\(totalGb) GB"
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
  var volumes: [DiskVolume]
  var reclaimable: GcReport.Reclaimable?

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xl) {
      SectionLabel(title: "Disk")
      ForEach(volumes) { volume in
        VStack(alignment: .leading, spacing: Space.sm) {
          HStack {
            Text(volume.name).font(.stim(.callout, weight: .semibold))
            Spacer()
            Text("\(formatDisk(volume.freeBytes)) free of \(formatDisk(volume.totalBytes))")
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
          Text(formatDisk(reclaimable.bytes)).font(.stim(.title)).foregroundStyle(Palette.primary)
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

/// A small toolbar button showing background Stim runs, so closing an activity sheet
/// does not lose track of it. Hidden when nothing is running.
struct ActivityToolbarIndicator: View {
  @ObservedObject var actions: ActionCenter

  var body: some View {
    let active = actions.activeRuns
    if let latest = active.last {
      Button {
        actions.presented = latest
      } label: {
        HStack(spacing: Space.xs) {
          ProgressView().controlSize(.mini)
          if active.count > 1 { Text("\(active.count)").font(.stim(.caption, mono: true)) }
        }
      }
      .help(
        (active.count == 1 ? "Running: \(latest.title)" : "\(active.count) commands running")
          + " \u{2014} click to show the latest output"
      )
      .accessibilityLabel(active.count == 1 ? "Running: \(latest.title)" : "\(active.count) commands running")
    }
  }
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

extension FocusedValues {
  @Entry var inspectorToggle: InspectorToggle?
}
