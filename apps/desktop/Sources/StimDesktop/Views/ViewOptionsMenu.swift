import StimKit
import StimStores
import SwiftUI

/// The sidebar's view options, stored in `UserDefaults`.
struct SidebarPreferences: DynamicProperty {
  @AppStorage(AppPreferences.Key.sidebarStatuses) var statuses = StatusFilter.encode(StatusFilter.defaultSelection)
  @AppStorage(AppPreferences.Key.hiddenProjects) var hiddenProjects = ""
  @AppStorage(AppPreferences.Key.hiddenWorkspaces) var hiddenWorkspacesRaw = ""
  @AppStorage(AppPreferences.Key.sidebarGrouping) var grouping = SidebarGrouping.project
  @AppStorage(AppPreferences.Key.sidebarSort) var sort = SidebarSort.name
  @AppStorage(AppPreferences.Key.showsGitStatus) var showsGitStatus = true
  @AppStorage(AppPreferences.Key.showsEmptyProjects) var showsEmptyProjects = false

  var options: SidebarOptions {
    var options = SidebarOptions()
    options.statuses = StatusFilter.decode(statuses)
    options.hiddenProjects = SidebarOptions.decode(hiddenProjects: hiddenProjects)
    options.hiddenWorkspaces = hiddenWorkspaces
    options.grouping = grouping
    options.sort = sort
    options.showsGitStatus = showsGitStatus
    options.showsEmptyProjects = showsEmptyProjects
    return options
  }

  var hiddenWorkspaces: HiddenWorkspaces { HiddenWorkspaces.decode(hiddenWorkspacesRaw) }

  func setHidden(_ hidden: Bool, path: String) {
    hiddenWorkspacesRaw = HiddenWorkspaces.encode(hiddenWorkspaces.setting(path: path, hidden: hidden))
  }

  @MainActor @discardableResult
  func setHidden(
    _ hidden: Bool, apps: [Workspace], actions: ActionCenter, migrating: Bool = false
  ) -> ActionRun? {
    guard let first = apps.first,
      !apps.contains(where: { actions.active(for: $0.path) != nil || actions.active(for: $0.worktreeActionKey) != nil })
    else { return nil }
    if apps.count == 1, first.pathMissing == true {
      // https://github.com/appandflow/stim/issues/2817: settings writes require an existing cwd; a missing-folder row stays local.
      guard hidden || first.hidden != true else { return nil }
      setHidden(hidden, path: first.path)
      return nil
    }
    return actions.run(
      hidden ? "Hide workspace" : "Unhide workspace",
      steps: apps.map {
        StimCommand(["settings", "set", "workspace.hidden", String(hidden), "--scope", "workspace"], cwd: $0.path)
      },
      key: apps.count > 1 ? first.worktreeActionKey : first.path, present: false
    ) { run in
      if run.exitStatus == 0 && !migrating {
        var local = self.hiddenWorkspaces
        local.paths.subtract(apps.map(\.path))
        self.hiddenWorkspacesRaw = HiddenWorkspaces.encode(local)
      }
    }
  }

  func setHidden(_ hidden: Bool, archives ids: [String]) {
    hiddenWorkspacesRaw = HiddenWorkspaces.encode(hiddenWorkspaces.setting(archives: ids, hidden: hidden))
  }

  func setHidden(_ hidden: Bool, entry: SidebarEntry) {
    switch entry {
    case .archived(let archive): setHidden(hidden, archives: [archive.id])
    case .archivedGroup(let group): setHidden(hidden, archives: group.map(\.id))
    default: setHidden(hidden, path: entry.path)
    }
  }

  func reset() {
    let defaults = SidebarOptions()
    statuses = StatusFilter.encode(defaults.statuses)
    hiddenProjects = ""
    grouping = defaults.grouping
    sort = defaults.sort
    showsGitStatus = defaults.showsGitStatus
    showsEmptyProjects = defaults.showsEmptyProjects
  }
}

struct ViewOptionsButton: View {
  var projects: [Project]
  var counts: [StatusFilter: Int]
  var title: (Project) -> String
  @Binding var isPresented: Bool
  @State private var isHovering = false
  let prefs = SidebarPreferences()

  var body: some View {
    let differs = prefs.options.differsFromDefaults(projects: projects)
    Button {
      isPresented.toggle()
    } label: {
      Image(systemName: "slider.horizontal.3")
        .iconFont(IconSize.regular, weight: .medium)
        .frame(width: 28, height: 28)
        .overlay(alignment: .topTrailing) {
          if differs {
            Circle().fill(Palette.primary).frame(width: 6, height: 6).offset(x: -2, y: 2)
          }
        }
    }
    .buttonStyle(.plain)
    .foregroundStyle(differs ? Palette.primary : Palette.secondary)
    .background {
      Circle().fill(isHovering ? Color.gray.opacity(0.15) : Color.clear)
    }
    .contentShape(Circle())
    .onHover { isHovering = $0 }
    .tutorialAnchor(.archivedFilter)
    .accessibilityLabel("View options")
    .help(differs ? "View options (filtered)" : "View options")
    .popover(isPresented: $isPresented, arrowEdge: .bottom) {
      ViewOptionsMenu(projects: projects, counts: counts, title: title)
    }
  }
}

struct ViewOptionsMenu: View {
  var projects: [Project]
  var counts: [StatusFilter: Int]
  var title: (Project) -> String
  let prefs = SidebarPreferences()

  var body: some View {
    MenuList(items: items)
  }

  private var items: [MenuItem] {
    let options = prefs.options
    let hidden = options.hiddenProjects
    let shown = projects.filter { !hidden.contains($0.root) }.count
    var items = [
      MenuItem(
        id: "status", title: "Status", accessory: .value(StatusFilter.summary(options.statuses)),
        submenu: statusItems(options.statuses)),
      MenuItem(
        id: "projects", title: "Projects",
        accessory: .value(shown == projects.count ? "All" : "\(shown) selected"),
        submenu: projectItems(hidden: hidden)),
      MenuItem(
        id: "group", title: "Group by", accessory: .value(options.grouping.title),
        submenu: SidebarGrouping.allCases.map { grouping in
          MenuItem(id: grouping.rawValue, title: grouping.title, accessory: .check(options.grouping == grouping)) {
            prefs.grouping = grouping
          }
        }),
      MenuItem(
        id: "sort", title: "Sort by", accessory: .value(options.sort.title),
        submenu: SidebarSort.allCases.map { sort in
          MenuItem(id: sort.rawValue, title: sort.title, accessory: .check(options.sort == sort)) {
            prefs.sort = sort
          }
        }),
      MenuItem(
        id: "git", title: "Show Git Status", accessory: .check(options.showsGitStatus), dividerBefore: true, keepsOpen: true
      ) {
        prefs.showsGitStatus.toggle()
      },
      MenuItem(
        id: "empty", title: "Show Empty Projects", accessory: .check(options.showsEmptyProjects), keepsOpen: true
      ) { prefs.showsEmptyProjects.toggle() },
    ]
    if options.differsFromDefaults(projects: projects) {
      items.append(MenuItem(id: "reset", title: "Reset", dividerBefore: true, keepsOpen: true) { prefs.reset() })
    }
    return items
  }

  private func statusItems(_ statuses: Set<StatusFilter>) -> [MenuItem] {
    var items = [
      MenuItem(
        id: "all", title: "All", accessory: .check(statuses.subtracting([.hidden]) == StatusFilter.all),
        keepsOpen: true
      ) {
        prefs.statuses = StatusFilter.encode(StatusFilter.all.union(statuses.intersection([.hidden])))
      }
    ]
    for (index, status) in StatusFilter.allCases.enumerated() {
      items.append(
        MenuItem(
          id: status.rawValue, title: status.title, detail: "\(counts[status] ?? 0)",
          accessory: .check(statuses.contains(status)), dividerBefore: index == 0 || status == .hidden, keepsOpen: true
        ) {
          var updated = statuses
          if updated.contains(status) { updated.remove(status) } else { updated.insert(status) }
          prefs.statuses = StatusFilter.encode(updated)
        })
    }
    return items
  }

  private func projectItems(hidden: Set<String>) -> [MenuItem] {
    let all = projects.allSatisfy { !hidden.contains($0.root) }
    var items = [
      MenuItem(id: "all", title: "All Projects", accessory: .check(all), keepsOpen: true) {
        prefs.hiddenProjects = ""
      }
    ]
    for (index, project) in projects.enumerated() {
      items.append(
        MenuItem(
          id: project.root, title: title(project), accessory: .check(!hidden.contains(project.root)),
          dividerBefore: index == 0, keepsOpen: true
        ) {
          var updated = hidden
          if updated.contains(project.root) { updated.remove(project.root) } else { updated.insert(project.root) }
          prefs.hiddenProjects = updated.isEmpty ? "" : SidebarOptions.encode(hiddenProjects: updated)
        })
    }
    return items
  }
}

struct MenuItem: Identifiable {
  enum Accessory {
    case none
    case value(String)
    case check(Bool)
  }

  var id: String
  var title: String
  var detail: String? = nil
  var accessory = Accessory.none
  var submenu: [MenuItem]?
  var dividerBefore = false
  var keepsOpen = false
  var action: () -> Void = {}
}

/// A popover menu drawn like a native one, with a value column and trailing checkmarks, which `Menu` cannot
/// show. Arrow keys move the highlight, Return or Space picks, Right opens a submenu and Left closes it. A
/// SwiftUI popover opened from another does not take keyboard focus, so this list handles its submenu's keys.
private struct MenuList: View {
  var items: [MenuItem]
  @State private var highlighted: String?
  @State private var openSubmenu: String?
  @State private var subHighlighted: String?
  @State private var hoveredParent: String?
  @State private var hoveredSubmenu: String?
  @State private var pendingClose: Task<Void, Never>?
  @FocusState private var focused: Bool

  private var submenu: [MenuItem]? { items.first { $0.id == openSubmenu }?.submenu }

  var body: some View {
    MenuRows(items: items, highlighted: $highlighted, pinned: openSubmenu, activate: activate, rowHover: rowHover)
      .backgroundPreferenceValue(SubmenuAnchors.self) { anchors in
        GeometryReader { geometry in
          if let id = openSubmenu, let anchor = anchors[id] {
            let row = geometry[anchor]
            Color.clear
              .frame(width: row.width, height: row.height)
              .popover(isPresented: submenuPresented, attachmentAnchor: .point(.trailing), arrowEdge: .trailing) {
                if let submenu {
                  MenuRows(items: submenu, highlighted: $subHighlighted, activate: activate)
                    .contentShape(Rectangle())
                    .onHover { submenuHover(id, inside: $0) }
                }
              }
              .position(x: row.midX, y: row.midY)
          }
        }
      }
      .focusable()
      .focusEffectDisabled()
      .focused($focused)
      .onAppear { focused = true }
      .task(id: hoveredParent) {
        guard let target = hoveredParent, openSubmenu == nil else { return }
        do {
          try await Task.sleep(for: .milliseconds(200))
        } catch { return }
        guard hoveredParent == target, openSubmenu == nil else { return }
        subHighlighted = nil
        openSubmenu = target
      }
      .onDisappear { pendingClose?.cancel() }
      .onChange(of: openSubmenu) {
        if openSubmenu == nil {
          pendingClose?.cancel()
          hoveredSubmenu = nil
        }
      }
      .onKeyPress(.downArrow) { move(1) }
      .onKeyPress(.upArrow) { move(-1) }
      .onKeyPress(.return) { activateHighlighted() }
      .onKeyPress(.space) { activateHighlighted() }
      .onKeyPress(.rightArrow) {
        guard openSubmenu == nil, let item = items.first(where: { $0.id == highlighted }), item.submenu != nil
        else { return .ignored }
        activate(item)
        return .handled
      }
      .onKeyPress(.leftArrow) {
        guard openSubmenu != nil else { return .ignored }
        openSubmenu = nil
        return .handled
      }
  }

  private var submenuPresented: Binding<Bool> {
    Binding(get: { openSubmenu != nil }, set: { if !$0 { openSubmenu = nil } })
  }

  private func rowHover(_ item: MenuItem, inside: Bool) {
    if inside {
      hoveredParent = item.submenu == nil ? nil : item.id
      if openSubmenu != nil, item.submenu != nil, openSubmenu != item.id {
        openSubmenu = item.id
        subHighlighted = nil
      }
    } else if hoveredParent == item.id {
      hoveredParent = nil
    }
    updateDismissal()
  }

  private func submenuHover(_ id: String, inside: Bool) {
    guard openSubmenu == id else { return }
    hoveredSubmenu = inside ? id : nil
    updateDismissal()
  }

  private func updateDismissal() {
    pendingClose?.cancel()
    guard let id = openSubmenu, hoveredParent == nil, hoveredSubmenu != id else { return }
    pendingClose = Task { @MainActor in
      do {
        try await Task.sleep(for: .milliseconds(220))
      } catch { return }
      if openSubmenu == id, hoveredParent == nil, hoveredSubmenu != id { openSubmenu = nil }
    }
  }

  private func activate(_ item: MenuItem) {
    if item.submenu != nil {
      openSubmenu = openSubmenu == item.id ? nil : item.id
      subHighlighted = nil
      return
    }
    item.action()
    if !item.keepsOpen { openSubmenu = nil }
  }

  private func activateHighlighted() -> KeyPress.Result {
    let list = submenu ?? items
    guard let item = list.first(where: { $0.id == (submenu == nil ? highlighted : subHighlighted) }) else {
      return .ignored
    }
    activate(item)
    return .handled
  }

  private func move(_ step: Int) -> KeyPress.Result {
    let list = submenu ?? items
    guard !list.isEmpty else { return .ignored }
    let current = list.firstIndex { $0.id == (submenu == nil ? highlighted : subHighlighted) }
    let next = current.map { ($0 + step + list.count) % list.count } ?? (step > 0 ? 0 : list.count - 1)
    if submenu == nil { highlighted = list[next].id } else { subHighlighted = list[next].id }
    return .handled
  }
}

private struct MenuRows: View {
  var items: [MenuItem]
  @Binding var highlighted: String?
  var pinned: String?
  var activate: (MenuItem) -> Void
  var rowHover: ((MenuItem, Bool) -> Void)?

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(items) { item in
        if item.dividerBefore {
          Divider().padding(.horizontal, Space.md).padding(.vertical, Space.xs)
        }
        Button {
          activate(item)
        } label: {
          MenuRow(item: item)
        }
        .buttonStyle(.hoverRow(selected: highlighted == item.id || pinned == item.id))
        .onHover { inside in
          if inside { highlighted = item.id } else if highlighted == item.id { highlighted = nil }
          rowHover?(item, inside)
        }
        .anchorPreference(key: SubmenuAnchors.self, value: .bounds) { item.submenu == nil ? [:] : [item.id: $0] }
      }
    }
    .padding(Space.xs)
    .frame(minWidth: 250, alignment: .leading)
    .fixedSize()
  }

}

private struct SubmenuAnchors: PreferenceKey {
  static var defaultValue: [String: Anchor<CGRect>] { [:] }

  static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
    value.merge(nextValue(), uniquingKeysWith: { _, next in next })
  }
}

private struct MenuRow: View {
  var item: MenuItem

  var body: some View {
    HStack(spacing: Space.md) {
      Text(item.title).foregroundStyle(Palette.text).lineLimit(1)
      Spacer(minLength: 16)
      if let detail = item.detail {
        Text(detail).foregroundStyle(Palette.tertiary).monospacedDigit()
      }
      switch item.accessory {
      case .none:
        EmptyView()
      case .value(let value):
        Text(value).foregroundStyle(Palette.secondary).lineLimit(1)
      case .check(let on):
        Image(systemName: "checkmark")
          .iconFont(IconSize.small, weight: .semibold)
          .foregroundStyle(Palette.primary)
          .opacity(on ? 1 : 0)
      }
      if item.submenu != nil {
        Image(systemName: "chevron.right")
          .iconFont(IconSize.compact, weight: .semibold)
          .foregroundStyle(Palette.tertiary)
      }
    }
    .font(.stim(.body))
    .padding(.horizontal, Space.md)
    .frame(height: 28)
    .contentShape(Rectangle())
  }
}
