import StimKit
import SwiftUI

/// The sidebar's view options, stored in `UserDefaults`.
struct SidebarPreferences: DynamicProperty {
  @AppStorage(AppPreferences.Key.sidebarStatus) var status = StatusFilter.all
  @AppStorage(AppPreferences.Key.hiddenProjects) var hiddenProjects = ""
  @AppStorage(AppPreferences.Key.sidebarGrouping) var grouping = SidebarGrouping.project
  @AppStorage(AppPreferences.Key.sidebarSort) var sort = SidebarSort.lastActivity
  @AppStorage(AppPreferences.Key.hidesUnprovisionedWorktrees) var hidesNoEnvironment = false
  @AppStorage(AppPreferences.Key.showsGitStatus) var showsGitStatus = true
  @AppStorage(AppPreferences.Key.showsEmptyProjects) var showsEmptyProjects = false

  var options: SidebarOptions {
    var options = SidebarOptions()
    options.status = status
    options.hiddenProjects = SidebarOptions.decode(hiddenProjects: hiddenProjects)
    options.grouping = grouping
    options.sort = sort
    options.showsNoEnvironment = !hidesNoEnvironment
    options.showsGitStatus = showsGitStatus
    options.showsEmptyProjects = showsEmptyProjects
    return options
  }

  func reset() {
    let defaults = SidebarOptions()
    status = defaults.status
    hiddenProjects = ""
    grouping = defaults.grouping
    sort = defaults.sort
    hidesNoEnvironment = !defaults.showsNoEnvironment
    showsGitStatus = defaults.showsGitStatus
    showsEmptyProjects = defaults.showsEmptyProjects
  }
}

struct ViewOptionsButton: View {
  var projects: [Project]
  @State private var isPresented = false
  let prefs = SidebarPreferences()

  var body: some View {
    let differs = prefs.options.differsFromDefaults(projects: projects)
    Button {
      isPresented.toggle()
    } label: {
      Image(systemName: "slider.horizontal.3")
        .font(.system(size: 13, weight: .medium))
        .frame(width: 28, height: 24)
        .overlay(alignment: .topTrailing) {
          if differs {
            Circle().fill(Palette.primary).frame(width: 6, height: 6).offset(x: -2, y: 2)
          }
        }
    }
    .buttonStyle(.icon(tint: differs ? Palette.primary : Palette.secondary, active: isPresented))
    .accessibilityLabel("View options")
    .help(differs ? "View options (filtered)" : "View options")
    .popover(isPresented: $isPresented, arrowEdge: .bottom) {
      ViewOptionsMenu(projects: projects)
    }
  }
}

private struct ViewOptionsMenu: View {
  var projects: [Project]
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
        id: "status", title: "Status", accessory: .value(options.status.title),
        submenu: StatusFilter.allCases.map { status in
          MenuItem(id: status.rawValue, title: status.title, accessory: .check(options.status == status)) {
            prefs.status = status
          }
        }),
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
        id: "noEnvironment", title: "Show no-environment worktrees", accessory: .check(options.showsNoEnvironment),
        dividerBefore: true, keepsOpen: true
      ) { prefs.hidesNoEnvironment.toggle() },
      MenuItem(id: "git", title: "Show git status", accessory: .check(options.showsGitStatus), keepsOpen: true) {
        prefs.showsGitStatus.toggle()
      },
      MenuItem(
        id: "empty", title: "Show empty projects", accessory: .check(options.showsEmptyProjects), keepsOpen: true
      ) { prefs.showsEmptyProjects.toggle() },
    ]
    if options.differsFromDefaults(projects: projects) {
      items.append(MenuItem(id: "reset", title: "Reset", dividerBefore: true, keepsOpen: true) { prefs.reset() })
    }
    return items
  }

  private func projectItems(hidden: Set<String>) -> [MenuItem] {
    let all = projects.allSatisfy { !hidden.contains($0.root) }
    var items = [
      MenuItem(id: "all", title: "All projects", accessory: .check(all), keepsOpen: true) {
        prefs.hiddenProjects = ""
      }
    ]
    for (index, project) in projects.enumerated() {
      items.append(
        MenuItem(
          id: project.root, title: project.name, accessory: .check(!hidden.contains(project.root)),
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
  @FocusState private var focused: Bool

  private var submenu: [MenuItem]? { items.first { $0.id == openSubmenu }?.submenu }

  var body: some View {
    MenuRows(items: items, highlighted: $highlighted, pinned: openSubmenu, activate: activate)
      .popover(isPresented: submenuShown, arrowEdge: .trailing) {
        if let submenu {
          MenuRows(items: submenu, highlighted: $subHighlighted, pinned: nil, activate: activate)
        }
      }
      .focusable()
      .focusEffectDisabled()
      .focused($focused)
      .onAppear { focused = true }
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

  private var submenuShown: Binding<Bool> {
    Binding(get: { openSubmenu != nil }, set: { if !$0 { openSubmenu = nil } })
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

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(items) { item in
        if item.dividerBefore {
          Divider().padding(.horizontal, Space.md).padding(.vertical, Space.xs)
        }
        Button {
          activate(item)
        } label: {
          MenuRow(item: item, highlighted: highlighted == item.id || pinned == item.id)
        }
        .buttonStyle(.plain)
        .onHover { inside in
          if inside { highlighted = item.id } else if highlighted == item.id { highlighted = nil }
        }
      }
    }
    .padding(Space.xs)
    .frame(minWidth: 250, alignment: .leading)
    .fixedSize()
  }
}

private struct MenuRow: View {
  var item: MenuItem
  var highlighted: Bool

  var body: some View {
    HStack(spacing: Space.md) {
      Text(item.title).foregroundStyle(Palette.text).lineLimit(1)
      Spacer(minLength: 16)
      switch item.accessory {
      case .none:
        EmptyView()
      case .value(let value):
        Text(value).foregroundStyle(Palette.secondary).lineLimit(1)
      case .check(let on):
        Image(systemName: "checkmark")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Palette.primary)
          .opacity(on ? 1 : 0)
      }
      if item.submenu != nil {
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(Palette.tertiary)
      }
    }
    .font(.stim(.body))
    .padding(.horizontal, Space.md)
    .frame(height: 28)
    .background(RoundedRectangle(cornerRadius: Radius.chip).fill(highlighted ? Palette.selection : Color.clear))
    .contentShape(Rectangle())
  }
}
