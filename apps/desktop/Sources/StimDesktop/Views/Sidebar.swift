import StimKit
import SwiftUI

struct Sidebar: View {
  @ObservedObject var store: StatusStore
  @ObservedObject var autopilot: AutopilotRunner
  @Binding var selection: SidebarItem?
  @AppStorage(AppPreferences.Key.expandedProjects) private var expandedProjects = Data()
  @Environment(\.colorScheme) private var colorScheme
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
                EntryRow(entry: entry, subtitle: nil, showsGit: options.showsGitStatus, selection: selection)
              }
            } label: {
              ProjectRow(summary: tree.summary, selected: selection == .project(tree.summary.project))
                .sidebarTag(.project(tree.summary.project), selection: selection)
            }
          }
          if trees.isEmpty { emptyText(options) }
        case .none:
          let entries = store.sidebarList(options)
          ForEach(entries) { entry in
            EntryRow(
              entry: entry, subtitle: store.project(ofPath: entry.path).name, showsGit: options.showsGitStatus,
              selection: selection)
          }
          if entries.isEmpty { emptyText(options) }
        }
      } header: {
        Text(options.grouping == .project ? "Projects" : "Workspaces").background(PlainSelectionHighlight())
      }
    }
    .scrollContentBackground(.hidden)
    .background(Theme.sidebar)
    .safeAreaInset(edge: .top, spacing: 0) {
      VStack(spacing: 0) {
        brand
        pinned
      }
      .background(Theme.sidebar)
    }
  }

  private var pinned: some View {
    VStack(spacing: 2) {
      PinnedRow(item: .wall, selection: $selection) {
        SidebarLabel(title: "All devices", icon: "square.grid.2x2", selected: selection == .wall)
      }
      PinnedRow(item: .attention, selection: $selection) {
        SidebarLabel(title: "Needs attention", icon: "exclamationmark.triangle", selected: selection == .attention)
        Spacer()
        let count = store.warningCount
        if count > 0 {
          Text("\(count)")
            .font(Theme.body(11, weight: .medium))
            .padding(.horizontal, 7)
            .padding(.vertical, 1)
            .background(Capsule().fill(Theme.warn.opacity(0.18)))
            .foregroundStyle(Theme.warn)
        }
      }
      PinnedRow(item: .storage, selection: $selection) {
        SidebarLabel(title: "Storage", icon: "internaldrive", selected: selection == .storage)
        Spacer()
        if autopilot.pressure != nil {
          Image(systemName: "exclamationmark.circle.fill").font(.system(size: 11)).foregroundStyle(Theme.warn)
            .help("Free disk is under the Stim budget")
        }
      }
    }
    .padding(.horizontal, 10)
    .padding(.bottom, 8)
  }

  private var brand: some View {
    HStack(spacing: 10) {
      if let logo = BrandAssets.logo(colorScheme) {
        Image(nsImage: logo).resizable().frame(width: 28, height: 28)
      }
      Text("Stim").font(Theme.heading(16))
      Spacer()
      ViewOptionsButton(
        projects: store.projectList.map(\.project).sorted { $0.name.lowercased() < $1.name.lowercased() })
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
  }

  @ViewBuilder
  private func emptyText(_ options: SidebarOptions) -> some View {
    HStack(spacing: 4) {
      if options.status != .all {
        Text("No \(options.status.rawValue) workspaces \u{00B7}").foregroundStyle(Theme.tertiary)
        Button("Show all") { prefs.status = .all }.buttonStyle(.plain).foregroundStyle(Theme.primary)
      } else if options.differsFromDefaults(projects: store.projectList.map(\.project)) {
        Text("Nothing matches \u{00B7}").foregroundStyle(Theme.tertiary)
        Button("Reset") { prefs.reset() }.buttonStyle(.plain).foregroundStyle(Theme.primary)
      } else {
        Text("No workspaces").foregroundStyle(Theme.tertiary)
      }
    }
    .font(Theme.body(12))
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
      Text(title)
    } icon: {
      Image(systemName: icon).foregroundStyle(selected ? Theme.primary : Theme.secondary)
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
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: 6)
            .fill(selection == item ? Theme.selected : hovering ? Theme.raised.opacity(0.5) : Color.clear))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
  }
}

struct ProjectRow: View {
  var summary: ProjectSummary
  var selected: Bool

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "folder")
        .foregroundStyle(selected || summary.live > 0 ? Theme.primary : Theme.tertiary)
      Text(summary.project.name).lineLimit(1).truncationMode(.middle)
      Spacer()
      if summary.live > 0 {
        Text("\(summary.live) live").font(Theme.body(11)).foregroundStyle(Theme.live).fixedSize()
      } else {
        Text("\(summary.total)").font(Theme.body(11)).foregroundStyle(Theme.tertiary).fixedSize()
      }
    }
  }
}

struct EntryRow: View {
  var entry: SidebarEntry
  var subtitle: String?
  var showsGit: Bool
  var selection: SidebarItem?

  var body: some View {
    switch entry {
    case .workspace(let env): WorkspaceRow(env: env, subtitle: subtitle, showsGit: showsGit, selection: selection)
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

  var body: some View {
    HStack(spacing: 10) {
      StatusDot(color: env.live ? Theme.live : Theme.tertiary, filled: env.live)
      VStack(alignment: .leading, spacing: 1) {
        Text(env.names.title).lineLimit(1)
        Text(subtitle ?? env.names.subtitle).font(Theme.body(11)).foregroundStyle(Theme.secondary).lineLimit(1)
      }
      Spacer()
      if showsGit { GitIndicator(git: env.worktree?.git) }
      if !env.warnings.isEmpty {
        Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 10)).foregroundStyle(Theme.warn)
      }
      if let metro = env.metro {
        Text(":\(String(metro.port))").font(Theme.mono(10.5)).foregroundStyle(Theme.tertiary)
      }
    }
    .sidebarTag(.environment(env.path), selection: selection)
  }
}

struct NoEnvironmentRow: View {
  var worktree: UnprovisionedWorktree
  var subtitle: String?
  var showsGit: Bool
  var selection: SidebarItem?

  var body: some View {
    let names = PathNames(path: worktree.path)
    HStack(spacing: 10) {
      StatusDot(color: Theme.tertiary, filled: false)
      VStack(alignment: .leading, spacing: 1) {
        Text(names.title).lineLimit(1)
        Text(subtitle ?? worktree.branch ?? names.subtitle)
          .font(Theme.body(11)).foregroundStyle(Theme.secondary).lineLimit(1)
      }
      Spacer()
      if showsGit, worktree.git?.isNotable == true {
        GitIndicator(git: worktree.git)
      } else {
        Text("no environment").font(Theme.body(10.5)).foregroundStyle(Theme.tertiary).fixedSize()
      }
    }
    .sidebarTag(.worktree(worktree.path), selection: selection)
  }
}

/// AppKit draws the selected source-list row as emphasized, which turns its disclosure chevron white on the
/// light `Theme.selected` background. The row background already marks the selection.
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
    tag(item).listRowBackground(item == selection ? Theme.selected : Color.clear)
  }
}
