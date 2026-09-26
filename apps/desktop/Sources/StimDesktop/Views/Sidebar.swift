import StimKit
import SwiftUI

struct Sidebar: View {
  @ObservedObject var store: StatusStore
  @ObservedObject var autopilot: AutopilotRunner
  @ObservedObject var onboarding: Onboarding
  @Binding var selection: SidebarItem?
  var openLogs: (String) -> Void
  @AppStorage(AppPreferences.Key.expandedProjects) private var expandedProjects = Data()
  let prefs = SidebarPreferences()

  var body: some View {
    let options = prefs.options
    List(selection: $selection) {
      Section {
        switch options.grouping {
        case .project:
          let trees = store.sidebarTrees(options)
          ForEach(trees, id: \.summary.project) { tree in
            DisclosureGroup(isExpanded: isExpanded(tree.summary)) {
              ForEach(tree.entries) { entry in
                EntryRow(
                  entry: entry, subtitle: nil, showsGit: options.showsGitStatus, selection: selection,
                  openLogs: openLogs)
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
              entry: entry, subtitle: store.project(ofPath: entry.path).name, showsGit: options.showsGitStatus,
              selection: selection, openLogs: openLogs)
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
      SidebarFooter(store: store, autopilot: autopilot, onboarding: onboarding, selection: $selection)
    }
  }

  private var pinned: some View {
    VStack(spacing: Space.xxs) {
      PinnedRow(item: .wall, selection: $selection) {
        SidebarLabel(title: "All devices", icon: "square.grid.2x2", selected: selection == .wall)
      }
      PinnedRow(item: .attention, selection: $selection) {
        SidebarLabel(title: "Needs attention", icon: "exclamationmark.triangle", selected: selection == .attention)
        Spacer()
        let count = store.attentionCount + autopilot.finishedPullRequests.count
        if count > 0 {
          Pill("\(count)", tone: .warning, size: .small)
        }
      }
      PinnedRow(item: .machine, selection: $selection) {
        SidebarLabel(title: "Machine", icon: "internaldrive", selected: selection == .machine)
        Spacer()
        if autopilot.pressure != nil {
          Image(systemName: "exclamationmark.circle.fill").font(.system(size: 11)).foregroundStyle(Palette.warning)
            .help("Free disk is under the Stim budget")
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
        projects: store.projectList.map(\.project).sorted { $0.name.lowercased() < $1.name.lowercased() })
    }
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.md)
  }

  @ViewBuilder
  private func emptyText(_ options: SidebarOptions) -> some View {
    HStack(spacing: Space.xs) {
      if options.status != .all {
        Text("No \(options.status.rawValue) workspaces \u{00B7}").foregroundStyle(Palette.tertiary)
        Button("Show all") { prefs.status = .all }.buttonStyle(.plain).foregroundStyle(Palette.primary)
      } else if options.differsFromDefaults(projects: store.projectList.map(\.project)) {
        Text("Nothing matches \u{00B7}").foregroundStyle(Palette.tertiary)
        Button("Reset") { prefs.reset() }.buttonStyle(.plain).foregroundStyle(Palette.primary)
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
      get: { choices[root] ?? (summary.live > 0) },
      set: { expanded in
        var updated = choices
        updated[root] = expanded
        expandedProjects = (try? JSONEncoder().encode(updated)) ?? expandedProjects
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
  @State private var hovering = false

  var body: some View {
    Button {
      selection = item
    } label: {
      HStack { content }
        .padding(.horizontal, Space.md)
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: Radius.chip)
            .fill(selection == item ? Palette.selection : hovering ? Palette.raised.opacity(0.5) : Color.clear))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
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
        .foregroundStyle(selected || summary.live > 0 ? Palette.primary : Palette.tertiary)
      Text(summary.project.name).lineLimit(1).truncationMode(.middle)
      Spacer()
      if summary.live > 0 {
        Text("\(summary.live) live").font(.stim(.caption)).foregroundStyle(Palette.success).fixedSize()
      } else {
        Text("\(summary.total)").font(.stim(.caption)).foregroundStyle(Palette.tertiary).fixedSize()
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
  var showsGit: Bool
  var selection: SidebarItem?
  var openLogs: (String) -> Void

  var body: some View {
    switch entry {
    case .workspace(let env):
      WorkspaceRow(env: env, subtitle: subtitle, showsGit: showsGit, selection: selection, openLogs: openLogs)
    case .worktree(let worktree):
      NoEnvironmentRow(worktree: worktree, subtitle: subtitle, showsGit: showsGit, selection: selection)
    }
  }
}

struct WorkspaceRow: View {
  var env: Workspace
  var subtitle: String?
  var showsGit: Bool
  var selection: SidebarItem?
  var openLogs: (String) -> Void
  @EnvironmentObject private var actions: ActionCenter
  @State private var confirmingStop = false
  @State private var removal: WorktreeRemoval?

  var body: some View {
    HStack(spacing: Space.md) {
      StatusDot(color: env.live ? Palette.success : Palette.tertiary, filled: env.live)
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: Space.sm) {
          Text(env.names.title).lineLimit(1).truncationMode(.middle).layoutPriority(1)
          Spacer(minLength: 0)
          if showsGit { GitIndicator(git: env.worktree?.git) }
          if let errors = env.logs?.errorsSinceMarker, errors > 0 {
            HStack(spacing: Space.xxs) {
              Image(systemName: "xmark.octagon.fill").font(.system(size: 10))
              Text("\(errors)").font(.stim(.caption2, weight: .semibold)).monospacedDigit()
            }
            .foregroundStyle(Palette.error)
            .fixedSize()
            .help(countLabel(errors, "error") + " in the logs")
          }
          if !env.warnings.isEmpty {
            Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10)).foregroundStyle(Palette.warning)
          }
        }
        HStack(spacing: Space.sm) {
          SidebarSubtitle(title: env.names.title, parts: [subtitle, env.names.inCheckout])
          Spacer(minLength: 0)
          if let metro = env.metro {
            Text(":\(String(metro.port))").font(.stim(.caption2, mono: true)).foregroundStyle(Palette.tertiary).fixedSize()
          }
        }
      }
    }
    .sidebarTag(.environment(env.path), selection: selection)
    .contextMenu {
      WorkspaceActionsMenu(
        kind: .workspace(metroRunning: env.metro?.running == true, platforms: env.runPlatforms),
        path: env.path,
        busy: actions.active(for: env.path) != nil,
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
            actions.run("Stop \(env.names.title)", StimCommand(["stop"], cwd: env.path))
          }
        },
        onShowLogs: { openLogs(env.path) },
        onRemoveWorktree: { resolveRemovalBranch(at: env.path) { removal = WorktreeRemoval(branch: $0) } })
    }
    .confirmationDialog("Stop this workspace?", isPresented: $confirmingStop, titleVisibility: .visible) {
      Button("Run stim stop", role: .destructive) {
        actions.run("Stop \(env.names.title)", StimCommand(["stop"], cwd: env.path))
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

private struct SidebarSubtitle: View {
  var title: String
  var parts: [String?]

  var body: some View {
    let text = parts.compactMap { $0 }.filter { $0 != title }.joined(separator: " \u{00B7} ")
    Text(text.isEmpty ? " " : text).font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(1)
      .truncationMode(.middle)
  }
}

struct NoEnvironmentRow: View {
  var worktree: UnprovisionedWorktree
  var subtitle: String?
  var showsGit: Bool
  var selection: SidebarItem?
  @EnvironmentObject private var actions: ActionCenter
  @State private var removal: WorktreeRemoval?

  var body: some View {
    let names = worktree.names
    HStack(spacing: Space.md) {
      StatusDot(color: Palette.tertiary, filled: false)
      VStack(alignment: .leading, spacing: 1) {
        Text(names.title).lineLimit(1).truncationMode(.middle)
        SidebarSubtitle(title: names.title, parts: [subtitle, names.inCheckout])
      }
      .layoutPriority(1)
      Spacer()
      if showsGit, worktree.git?.isNotable == true {
        GitIndicator(git: worktree.git)
      } else {
        Text("no environment").font(.stim(.caption2)).foregroundStyle(Palette.tertiary).fixedSize()
      }
    }
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
    tag(item).listRowBackground(item == selection ? Palette.selection : Color.clear)
  }
}

/// The sidebar's pinned bottom bar: one status line at a time on the left (`SidebarFooterStatus`), and
/// up to three small icon buttons on the right, each hidden rather than disabled when it does not apply.
struct SidebarFooter: View {
  @ObservedObject var store: StatusStore
  @ObservedObject var autopilot: AutopilotRunner
  @ObservedObject var onboarding: Onboarding
  @ObservedObject private var updater = AppUpdater.shared
  @ObservedObject private var server = ServerController.shared
  @Binding var selection: SidebarItem?
  @AppStorage(AppPreferences.Key.servesPhones) private var servesPhones = false
  @AppStorage("settingsTab") private var settingsTab = "app"
  @Environment(\.openSettings) private var openSettings

  private var status: SidebarFooterStatus {
    SidebarFooterStatus.decide(
      stim: onboarding.report?.stim, pressure: autopilot.pressure,
      desktopUpdateAvailable: updater.isAvailable && updater.updateAvailable)
  }

  private var drivenDevices: [DrivenDevice] { DrivenDevice.all(in: store.payload?.environments ?? []) }

  var body: some View {
    HStack(spacing: Space.sm) {
      leftStatus
      Spacer(minLength: 8)
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
      Button(action: onboarding.installStim) {
        statusLabel(dot: Palette.warning, text: compatibility == .missing ? "Install stim" : "stim update available")
      }
      .buttonStyle(.plain)
    case .diskCritical(let freeBytes):
      Button { selection = .machine } label: {
        statusLabel(dot: Palette.error, text: "Low disk: \(formatDisk(freeBytes)) free")
      }
      .buttonStyle(.plain)
    case .desktopUpdateAvailable:
      Button(action: updater.checkForUpdates) {
        statusLabel(dot: Palette.primary, text: "Update available")
      }
      .buttonStyle(.plain)
    case .diskWarning(let freeBytes):
      Button { selection = .machine } label: {
        statusLabel(dot: Palette.warning, text: "Low disk: \(formatDisk(freeBytes)) free")
      }
      .buttonStyle(.plain)
    case .normal(let version):
      statusLabel(dot: Palette.success, text: version.map { "Stim \($0)" } ?? "Stim")
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
    (["\(drivenDevices.count) device\(drivenDevices.count == 1 ? "" : "s") driven by an agent:"]
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
    guard case .running(let health, _) = server.state, let route = health.route, let dnsName = health.tailscale.dnsName
    else { return "Phones on" }
    return "Phones connect to \(route.endpoint(dnsName: dnsName))"
  }

  private var settingsButton: some View {
    IconButton(systemImage: "gearshape", help: "Settings") { openSettings() }
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
