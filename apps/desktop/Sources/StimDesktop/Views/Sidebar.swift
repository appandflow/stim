import StimKit
import StimStores
import SwiftUI

struct Sidebar: View {
  @ObservedObject var store: StatusStore
  @ObservedObject var autopilot: AutopilotRunner
  @ObservedObject var onboarding: Onboarding
  let actions: ActionCenter
  @ObservedObject private var inbox = NotificationInbox.shared
  @Binding var selection: SidebarItem?
  var openLogs: (String) -> Void
  @AppStorage(AppPreferences.Key.expandedProjects) private var expandedProjects = Data()
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let prefs = SidebarPreferences()

  var body: some View {
    let options = prefs.options
    List(selection: $selection) {
      Section {
        switch options.grouping {
        case .project:
          let trees = store.sidebarTrees(options)
          ForEach(trees, id: \.summary.project) { tree in
            let folders = Set(store.environments(in: tree.summary.project).map { $0.names.inCheckout ?? "" })
            DisclosureGroup(isExpanded: isExpanded(tree.summary)) {
              ForEach(tree.entries) { entry in
                EntryRow(
                  entry: entry, subtitle: nil, showsFolder: folders.count > 1, showsGit: options.showsGitStatus,
                  selection: selection, openLogs: openLogs)
              }
            } label: {
              ProjectRow(store: store, summary: tree.summary, selected: selection == .project(tree.summary.project))
                .sidebarTag(.project(tree.summary.project), selection: selection)
            }
          }
          if trees.isEmpty { emptyText(options) }
        case .none:
          let entries = store.sidebarList(options)
          ForEach(entries) { entry in
            EntryRow(
              entry: entry, subtitle: store.title(of: store.project(ofPath: entry.path)), showsFolder: true,
              showsGit: options.showsGitStatus, selection: selection, openLogs: openLogs)
          }
          if entries.isEmpty { emptyText(options) }
        }
      } header: {
        Text(options.grouping == .project ? "Projects" : "Workspaces").background(PlainSelectionHighlight())
      }
    }
    .scrollContentBackground(.hidden)
    .background(Palette.sidebar)
    .safeAreaInset(edge: .top, spacing: 0) {
      VStack(spacing: 0) {
        brand
        pinned
      }
      .background(Palette.sidebar)
    }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      SidebarFooter(store: store, autopilot: autopilot, onboarding: onboarding, actions: actions, selection: $selection)
    }
  }

  private var pinned: some View {
    VStack(spacing: Space.xxs) {
      PinnedRow(item: .wall, selection: $selection) {
        SidebarLabel(title: "All devices", icon: "square.grid.2x2", selected: selection == .wall)
      }
      PinnedRow(item: .notifications, selection: $selection) {
        SidebarLabel(title: "Notifications", icon: "bell", selected: selection == .notifications)
        Spacer()
        let unread = inbox.inbox.unreadCount
        if unread > 0 {
          Pill(unread > 99 ? "99+" : "\(unread)", tone: .brand, size: .small)
            .help("\(unread) unread notification\(unread == 1 ? "" : "s")")
        }
      }
      PinnedRow(item: .machine, selection: $selection) {
        SidebarLabel(title: "Machines", icon: "internaldrive", selected: selection == .machine)
        Spacer()
        if autopilot.pressure != nil {
          Image(systemName: "exclamationmark.circle.fill").font(.system(size: 11)).foregroundStyle(Palette.warning)
            .help("Free disk is under the Stim budget")
            .accessibilityLabel("Free disk is under the Stim budget")
        }
      }
    }
    .padding(.horizontal, Space.md)
    .padding(.bottom, Space.md)
  }

  private var brand: some View {
    HStack(spacing: Space.md) {
      StimWordmark()
      Spacer()
      ViewOptionsButton(
        projects: store.projectList.map(\.project).sorted { $0.name.lowercased() < $1.name.lowercased() },
        title: store.title(of:))
    }
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
  }

  @ViewBuilder
  private func emptyText(_ options: SidebarOptions) -> some View {
    HStack(spacing: Space.xs) {
      if options.status != .all {
        Text("No \(options.status.rawValue) workspaces \u{00B7}").foregroundStyle(Palette.tertiary)
        Button("Show all") { prefs.status = .all }.buttonStyle(.hoverRow(outset: Space.xs)).foregroundStyle(Palette.primary)
      } else if options.differsFromDefaults(projects: store.projectList.map(\.project)) {
        Text("Nothing matches \u{00B7}").foregroundStyle(Palette.tertiary)
        Button("Reset") { prefs.reset() }.buttonStyle(.hoverRow(outset: Space.xs)).foregroundStyle(Palette.primary)
      } else {
        Text("No workspaces").foregroundStyle(Palette.tertiary)
      }
    }
    .font(.stim(.callout))
  }

  private func isExpanded(_ summary: ProjectSummary) -> Binding<Bool> {
    let root = summary.project.root
    let choices = (try? JSONDecoder().decode([String: Bool].self, from: expandedProjects)) ?? [:]
    return Binding(
      get: { choices[root] ?? summary.hasActive },
      set: { expanded in
        var updated = choices
        updated[root] = expanded
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
          expandedProjects = (try? JSONEncoder().encode(updated)) ?? expandedProjects
        }
      })
  }
}

struct SidebarLabel: View {
  var title: String
  var icon: String
  var selected: Bool

  var body: some View {
    Label {
      Text(title).lineLimit(1)
    } icon: {
      Image(systemName: icon).foregroundStyle(selected ? Palette.primary : Palette.secondary)
    }
  }
}

private struct PinnedRow<Content: View>: View {
  var item: SidebarItem
  @Binding var selection: SidebarItem?
  @ViewBuilder var content: Content

  var body: some View {
    Button {
      selection = item
    } label: {
      HStack { content }
        .padding(.horizontal, Space.md)
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
    }
    .buttonStyle(.hoverRow(selected: selection == item))
    .accessibilityAddTraits(selection == item ? .isSelected : [])
  }
}

struct ProjectRow: View {
  @ObservedObject var store: StatusStore
  var summary: ProjectSummary
  var selected: Bool
  @EnvironmentObject private var actions: ActionCenter
  @State private var confirmingStopAll = false

  var body: some View {
    HStack(spacing: Space.md) {
      Image(systemName: "folder")
        .foregroundStyle(selected || summary.hasActive ? Palette.primary : Palette.tertiary)
        .accessibilityHidden(true)
      Text(store.title(of: summary.project)).lineLimit(1).truncationMode(.middle)
      Spacer()
      if summary.live > 0 {
        Text("\(summary.live) live").font(.stim(.caption)).foregroundStyle(Palette.success).fixedSize()
          .help("\(countLabel(summary.live, "live workspace")) of \(summary.total)")
      } else if summary.settingUp > 0 {
        Text("\(summary.settingUp) new").font(.stim(.caption)).foregroundStyle(Palette.accent).fixedSize()
          .help("\(countLabel(summary.settingUp, "workspace")) warming or warmed, none live yet")
      } else {
        Text("\(summary.total)").font(.stim(.caption)).foregroundStyle(Palette.tertiary).fixedSize()
          .help("\(countLabel(summary.total, "workspace")), none live")
      }
    }
    .contextMenu {
      WorkspaceActionsMenu(
        kind: .project, path: summary.project.root, busy: false, removalAllowed: true,
        onStopAllLiveWorkspaces: { confirmingStopAll = true })
    }
    .confirmationDialog(
      "Stop every live workspace in \(summary.project.name)?", isPresented: $confirmingStopAll,
      titleVisibility: .visible
    ) {
      Button("Run stim stop", role: .destructive) {
        let live = store.environments(in: summary.project).filter(\.live)
        actions.run(
          "Stop \(summary.project.name)", steps: live.map { StimCommand(["stop"], cwd: $0.path) },
          key: "project:\(summary.project.root)")
      }
    } message: {
      Text("This also ends any billable EAS Simulator sessions those workspaces hold.")
    }
  }
}

struct EntryRow: View {
  var entry: SidebarEntry
  var subtitle: String?
  var showsFolder: Bool
  var showsGit: Bool
  var selection: SidebarItem?
  var openLogs: (String) -> Void

  var body: some View {
    switch entry {
    case .workspace(let env):
      WorkspaceRow(
        env: env, place: place(env.names), showsGit: showsGit, selection: selection, openLogs: openLogs)
    case .worktree(let worktree):
      NoEnvironmentRow(worktree: worktree, place: subtitle.map { [$0] } ?? [], showsGit: showsGit, selection: selection)
    }
  }

  private func place(_ names: PathNames) -> [String] {
    [subtitle, showsFolder ? names.inCheckout : nil].compactMap { $0 }.filter { $0 != names.title }
  }
}

struct WorkspaceRow: View {
  var env: Workspace
  var place: [String]
  var showsGit: Bool
  var selection: SidebarItem?
  var openLogs: (String) -> Void
  @EnvironmentObject private var actions: ActionCenter
  @State private var confirmingStop = false
  @State private var removal: WorktreeRemoval?

  var body: some View {
    TimelineView(.everyMinute) { _ in
      WorkspaceRowContent(env: env, now: Date(), place: place, showsGit: showsGit, openLogs: openLogs)
    }
    .sidebarTag(.environment(env.path), selection: selection)
    .contextMenu {
      WorkspaceActionsMenu(
        kind: .workspace(
          metroRunning: env.metro?.running == true, platforms: env.runPlatforms,
          linkedWorktree: env.worktree != nil),
        path: env.path,
        busy: actions.active(for: env.path) != nil,
        removalAllowed: worktreeRemovalAllowed(git: env.worktree?.git),
        building: env.build?.isRunning == true,
        reloadAllowed: env.canReload,
        onShowLastOutput: actions.latest(for: env.path).map { last in { actions.presented = last } },
        onRun: { platform in actions.runApp(env, platform: platform) },
        onReload: { actions.run("Reload \(env.names.title)", steps: [StimCommand(["reload"], cwd: env.path)], present: false) },
        onStartDevServer: { actions.run("Start \(env.names.title)", StimCommand(["start"], cwd: env.path)) },
        onStopDevServer: {
          if env.remoteDevices?.isEmpty == false {
            confirmingStop = true
          } else {
            actions.run("Stop \(env.names.title)", steps: [StimCommand(["stop"], cwd: env.path)], present: false)
          }
        },
        onShowLogs: { openLogs(env.path) },
        onRemoveWorktree: { resolveRemovalBranch(at: env.path) { removal = WorktreeRemoval(branch: $0) } })
    }
    .confirmationDialog("Stop this workspace?", isPresented: $confirmingStop, titleVisibility: .visible) {
      Button("Run stim stop", role: .destructive) {
        actions.run("Stop \(env.names.title)", steps: [StimCommand(["stop"], cwd: env.path)], present: false)
      }
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
}

private struct WorkspaceRowContent: View {
  var env: Workspace
  var now: Date
  var place: [String]
  var showsGit: Bool
  var openLogs: (String) -> Void

  var body: some View {
    let status = env.rowStatus(now: now)
    let sessions = AgentSession.associated(agents: env.agents, endedAgents: env.endedAgents)
    let live = env.isActive
    HStack(alignment: .top, spacing: Space.md) {
      StatusDot(color: Color(status.tone), filled: live)
        .padding(.top, Space.sm - 1)
      VStack(alignment: .leading, spacing: Space.xs) {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
          Text(env.names.title).foregroundStyle(live ? Palette.text : Palette.secondary)
            .lineLimit(1).truncationMode(.middle).layoutPriority(1)
          Spacer(minLength: 0)
          Text(status.text).font(.stim(.caption, weight: .medium)).foregroundStyle(Color(status.tone))
            .lineLimit(1).fixedSize()
        }
        if let session = sessions.first {
          SessionLine(session: session, others: sessions.count - 1)
        }
        RowDetailLine(
          context: context(env.rowDevices(now: now)), git: showsGit ? GitChip(env.worktree) : nil)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      env.rowLabel(now: now, folder: place.isEmpty ? nil : place.joined(separator: ", "), showsGit: showsGit)
    )
    .accessibilityActions {
      if (env.logs?.errorsSinceMarker ?? 0) > 0 {
        Button("Show errors") { openLogs(env.path) }
      }
    }
  }

  private func context(_ devices: RowDevices) -> Text? {
    var parts: [Text] = []
    if let names = devices.names { parts.append(Text(names).foregroundStyle(Palette.secondary)) }
    if let drivers = devices.drivers {
      parts.append(Text("\(Image(systemName: "cursorarrow.rays")) \(drivers)").foregroundStyle(Palette.primary))
    }
    if let idle = devices.idle { parts.append(Text(idle.text).foregroundStyle(Palette.tertiary)) }
    if devices.remote > 0 {
      let text = devices.remote == 1 ? "EAS session" : "\(devices.remote) EAS sessions"
      parts.append(Text(text).foregroundStyle(Palette.info))
    }
    parts += place.map { Text($0).foregroundStyle(Palette.tertiary) }
    return RowDetailLine.joined(parts)
  }
}

private struct SessionLine: View {
  var session: AgentSession
  var others: Int

  var body: some View {
    HStack(spacing: Space.xs) {
      AgentIcon(tool: session.tool, size: 11)
      Text(session.title.flatMap { $0.isEmpty ? nil : $0 } ?? session.toolName).lineLimit(1).truncationMode(.tail)
      if others > 0 { Text("+\(others)").foregroundStyle(Palette.tertiary).fixedSize() }
    }
    .font(.stim(.caption))
    .foregroundStyle(Palette.secondary)
  }
}

private struct RowDetailLine: View {
  var context: Text?
  var git: GitChip?

  static func joined(_ parts: [Text]) -> Text? {
    guard let first = parts.first else { return nil }
    return parts.dropFirst().reduce(first) { $0 + Text(" \u{00B7} ").foregroundStyle(Palette.tertiary) + $1 }
  }

  private var gitText: Text? {
    guard let git else { return nil }
    var parts: [Text] = []
    if let pull = git.pullRequest { parts.append(Text(pull.text).fontWeight(.medium).foregroundStyle(Color(pull.tone))) }
    for part in git.parts {
      parts.append(Text(part.text).foregroundStyle(part.tone == .normal ? Palette.secondary : Color(part.tone)))
    }
    return Self.joined(parts)
  }

  var body: some View {
    let lines = [context, gitText].compactMap { $0 }
    Group {
      if lines.count == 2, let joined = Self.joined(lines) {
        ViewThatFits(in: .horizontal) {
          joined.lineLimit(1).fixedSize()
          VStack(alignment: .leading, spacing: Space.xs) {
            ForEach(lines.indices, id: \.self) { lines[$0].lineLimit(1).truncationMode(.tail) }
          }
        }
      } else if let line = lines.first {
        line.lineLimit(1).truncationMode(.tail)
      }
    }
    .font(.stim(.caption))
    .monospacedDigit()
  }
}

struct NoEnvironmentRow: View {
  var worktree: UnprovisionedWorktree
  var place: [String]
  var showsGit: Bool
  var selection: SidebarItem?
  @EnvironmentObject private var actions: ActionCenter
  @State private var removal: WorktreeRemoval?

  var body: some View {
    let names = worktree.names
    let git = showsGit ? GitChip(worktree.info) : nil
    HStack(alignment: .top, spacing: Space.md) {
      StatusDot(color: Palette.tertiary, filled: false)
        .padding(.top, Space.sm - 1)
      VStack(alignment: .leading, spacing: Space.xs) {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
          Text(names.title).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle).layoutPriority(1)
          Spacer(minLength: 0)
          Text("No environment").font(.stim(.caption, weight: .medium)).foregroundStyle(Palette.tertiary).fixedSize()
        }
        RowDetailLine(
          context: RowDetailLine.joined(place.map { Text($0).foregroundStyle(Palette.tertiary) }), git: git)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(([names.title, "No environment", git?.label].compactMap { $0 } + place).joined(separator: ", "))
    .sidebarTag(.worktree(worktree.path), selection: selection)
    .contextMenu {
      WorkspaceActionsMenu(
        kind: .worktree,
        path: worktree.path,
        busy: actions.active(for: worktree.path) != nil,
        removalAllowed: worktreeRemovalAllowed(git: worktree.git),
        onWarmWorktree: {
          actions.run("Warm \(names.title)", StimCommand(["worktree", "warm"], cwd: worktree.path))
        },
        onRemoveWorktree: { resolveRemovalBranch(at: worktree.path) { removal = WorktreeRemoval(branch: $0) } })
    }
    .confirmationDialog(
      "Remove this worktree?",
      isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } }),
      titleVisibility: .visible,
      presenting: removal
    ) { _ in
      Button("Run stim worktree remove", role: .destructive) {
        actions.run("Remove \(names.title)", StimCommand(["worktree", "remove"], cwd: worktree.path))
      }
    } message: { removal in
      Text(worktreeRemovalMessage(path: worktree.path, branch: removal.branch))
    }
  }
}

/// AppKit draws the selected source-list row as emphasized, which turns its disclosure chevron white on the
/// light `Palette.selection` background. The row background already marks the selection.
private struct PlainSelectionHighlight: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView { NSView() }

  func updateNSView(_ view: NSView, context: Context) {
    DispatchQueue.main.async {
      var ancestor = view.superview
      while let current = ancestor, !(current is NSTableView) { ancestor = current.superview }
      (ancestor as? NSTableView)?.selectionHighlightStyle = .none
    }
  }
}

extension View {
  fileprivate func sidebarTag(_ item: SidebarItem, selection: SidebarItem?) -> some View {
    modifier(SidebarRowBackground(item: item, selection: selection))
  }
}

private struct SidebarRowBackground: ViewModifier {
  var item: SidebarItem
  var selection: SidebarItem?
  @State private var hovering = false

  func body(content: Content) -> some View {
    content
      .contentShape(Rectangle())
      .onHover { hovering = $0 }
      .tag(item)
      .listRowBackground(
        item == selection || hovering
          ? HoverFill(hovering: hovering, selected: item == selection).padding(.horizontal, Space.md)
          : nil)
  }
}

/// The sidebar's pinned bottom bar: one status line at a time on the left (`SidebarFooterStatus`), and
/// up to four small icon buttons on the right, each hidden rather than disabled when it does not apply.
struct SidebarFooter: View {
  @ObservedObject var store: StatusStore
  @ObservedObject var autopilot: AutopilotRunner
  @ObservedObject var onboarding: Onboarding
  let actions: ActionCenter
  @ObservedObject private var updater = AppUpdater.shared
  @ObservedObject private var server = ServerController.shared
  @Binding var selection: SidebarItem?
  @AppStorage(AppPreferences.Key.servesPhones) private var servesPhones = false
  @AppStorage("settingsTab") private var settingsTab = "app"
  @Environment(\.openSettings) private var openSettings

  private var status: SidebarFooterStatus {
    SidebarFooterStatus.decide(
      stim: onboarding.report?.stim, pressure: autopilot.pressure,
      desktopUpdateAvailable: updater.isAvailable && updater.updateAvailable, stimUpdate: onboarding.stimUpdate)
  }

  private var drivenDevices: [DrivenDevice] { DrivenDevice.all(in: store.payload?.environments ?? []) }

  var body: some View {
    HStack(spacing: Space.sm) {
      if StimHome.isDefault(store.stimHome) {
        leftStatus
      } else {
        VStack(alignment: .leading, spacing: 0) {
          leftStatus
          Text(abbreviatingHome(store.stimHome))
            .font(.stim(.caption, mono: true))
            .foregroundStyle(Palette.tertiary)
            .lineLimit(1)
            .truncationMode(.head)
            .help(store.stimHome)
        }
      }
      Spacer(minLength: 8)
      OperationsButton(log: actions.operations, actions: actions, store: store)
      if !drivenDevices.isEmpty { agentsButton }
      if servesPhones { phonesButton }
      settingsButton
    }
    .padding(.horizontal, Space.md)
    .frame(height: 44)
    .background(Palette.sidebar)
    .overlay(alignment: .top) { Rectangle().fill(Palette.border).frame(height: 1) }
  }

  @ViewBuilder private var leftStatus: some View {
    switch status {
    case .stimUnavailable(let compatibility):
      let text = compatibility == .missing ? "Install stim" : "stim update available"
      if onboarding.installCLICommand == nil {
        statusLabel(dot: Palette.warning, text: text)
          .help(
            "This stim is older than Stim Desktop needs, and no package manager installed it. Update it where it came from"
          )
      } else {
        Button(action: onboarding.installStim) {
          statusLabel(dot: Palette.warning, text: text)
        }
        .buttonStyle(.hoverRow(outset: Space.sm))
        .help(
          compatibility == .missing
            ? "Stim Desktop cannot find stim \u{2014} click to install it with \(onboarding.installer.rawValue)"
            : "This stim is older than Stim Desktop needs, or its version is unreadable \u{2014} click to update it with \(onboarding.report?.stimOwner?.rawValue ?? "its package manager")"
        )
      }
    case .stimUpdateAvailable(let installed, let latest):
      Button(action: onboarding.installStim) {
        statusLabel(dot: Palette.primary, text: "stim \(latest.description) available")
      }
      .buttonStyle(.hoverRow(outset: Space.sm))
      .help(
        "stim \(installed.description) is installed \u{2014} click to update it with \(onboarding.report?.stimOwner?.rawValue ?? "its package manager")"
      )
    case .diskCritical(let freeBytes):
      Button {
        selection = .machine
      } label: {
        statusLabel(dot: Palette.error, text: "Low disk: \(Format.fileSize(freeBytes)) free")
      }
      .buttonStyle(.hoverRow(outset: Space.sm))
      .help("Free disk is below Stim's hard floor, so start, ios and android refuse \u{2014} click to open Machine")
    case .desktopUpdateAvailable:
      Button(action: updater.checkForUpdates) {
        statusLabel(dot: Palette.primary, text: "Update available")
      }
      .buttonStyle(.hoverRow(outset: Space.sm))
      .help("A new version of Stim Desktop is available \u{2014} click to install it")
    case .diskWarning(let freeBytes):
      Button {
        selection = .machine
      } label: {
        statusLabel(dot: Palette.warning, text: "Low disk: \(Format.fileSize(freeBytes)) free")
      }
      .buttonStyle(.hoverRow(outset: Space.sm))
      .help("Free disk is under the Stim budget \u{2014} click to open Machine")
    case .normal(let version):
      let help: String =
        version.map { "stim \($0) is installed and works with this Stim Desktop" } ?? "Checking the installed stim"
      statusLabel(dot: Palette.success, text: version.map { "Stim \($0)" } ?? "Stim")
        .help(help)
    }
  }

  private func statusLabel(dot: Color, text: String) -> some View {
    HStack(spacing: Space.sm) {
      Circle().fill(dot).frame(width: 6, height: 6)
      Text(text).font(.stim(.footnote)).foregroundStyle(Palette.secondary).lineLimit(1)
    }
  }

  private var agentsButton: some View {
    IconButton(
      systemImage: "cursorarrow.rays", tint: Palette.accent, badge: "\(drivenDevices.count)", help: agentsTooltip
    ) {
      selection = .wall
    }
  }

  private var agentsTooltip: String {
    let count = drivenDevices.count
    return
      (["\(count) device\(count == 1 ? "" : "s") driven by an agent or tool \u{2014} click to show all devices"]
      + drivenDevices.map { "\($0.workspaceTitle) \u{2192} \($0.deviceLabel)" }).joined(separator: "\n")
  }

  private var phonesButton: some View {
    IconButton(systemImage: "iphone.gen3.radiowaves.left.and.right", help: phonesTooltip) {
      OpenRequests.shared.pairsPhone = true
      settingsTab = "phones"
      openSettings()
    }
  }

  private var phonesTooltip: String {
    switch server.state {
    case .off: return "Phone server is off \u{2014} click to open Phones settings"
    case .starting: return "Phone server is starting \u{2014} click to open Phones settings"
    case .failed(let message): return "Phone server failed: \(message) \u{2014} click to open Phones settings"
    case .running(let health, _):
      guard let route = health.route, let dnsName = health.tailscale.dnsName else {
        return "Phone server is running, but phones cannot reach it over Tailscale yet \u{2014} click to pair a phone"
      }
      return "Phone server is running at \(route.endpoint(dnsName: dnsName)) \u{2014} click to pair a phone"
    }
  }

  private var settingsButton: some View {
    IconButton(systemImage: "gearshape", help: "Settings (\u{2318},)", label: "Settings") { openSettings() }
  }
}

/// The hand-lettered "Stim" wordmark, tinted to `Palette.primary` for both appearances.
struct StimWordmark: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var wiggles = 0

  var body: some View {
    if let wordmark = BrandAssets.wordmark {
      Image(nsImage: wordmark)
        .resizable()
        .renderingMode(.template)
        .aspectRatio(contentMode: .fit)
        .frame(height: 22)
        .foregroundStyle(Palette.primary)
        .keyframeAnimator(initialValue: Wiggle(), trigger: wiggles) { content, value in
          content.rotationEffect(.degrees(value.angle)).scaleEffect(value.scale)
        } keyframes: { _ in
          KeyframeTrack(\.angle) {
            CubicKeyframe(-6, duration: 0.1)
            CubicKeyframe(5, duration: 0.1)
            CubicKeyframe(-3, duration: 0.1)
            CubicKeyframe(1.5, duration: 0.1)
            CubicKeyframe(0, duration: 0.1)
          }
          KeyframeTrack(\.scale) {
            CubicKeyframe(1.06, duration: 0.15)
            SpringKeyframe(1, duration: 0.35)
          }
        }
        .onHover { inside in
          if inside && !reduceMotion { wiggles += 1 }
        }
        .accessibilityLabel("Stim")
    }
  }

  private struct Wiggle {
    var angle = 0.0
    var scale = 1.0
  }
}
