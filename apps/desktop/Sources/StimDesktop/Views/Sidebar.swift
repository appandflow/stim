import StimKit
import SwiftUI

struct Sidebar: View {
  @ObservedObject var store: StatusStore
  @ObservedObject var autopilot: AutopilotRunner
  @Binding var selection: SidebarItem?
  @AppStorage(AppPreferences.Key.showsIdleWorkspaces) private var showsIdle = true
  @AppStorage(AppPreferences.Key.hidesUnprovisionedWorktrees) private var hidesUnprovisioned = false
  @AppStorage(AppPreferences.Key.expandedProjects) private var expandedProjects = Data()
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    let trees = store.projectTree(liveOnly: !showsIdle, hidesUnprovisioned: hidesUnprovisioned)
    List(selection: $selection) {
      SidebarLabel(title: "All devices", icon: "square.grid.2x2", selected: selection == .wall)
        .background(PlainSelectionHighlight())
        .sidebarTag(.wall, selection: selection)

      Section("Projects") {
        ForEach(trees, id: \.summary.project) { tree in
          DisclosureGroup(isExpanded: isExpanded(tree.summary)) {
            ForEach(tree.environments) { env in WorkspaceRow(env: env, selection: selection) }
            ForEach(tree.worktrees, id: \.path) { worktree in
              NoEnvironmentRow(worktree: worktree, selection: selection)
            }
          } label: {
            ProjectRow(summary: tree.summary, selected: selection == .project(tree.summary.project))
              .sidebarTag(.project(tree.summary.project), selection: selection)
          }
        }
        if trees.isEmpty, !showsIdle || hidesUnprovisioned {
          Text(showsIdle ? "No workspaces" : "Nothing live").foregroundStyle(Theme.tertiary)
        }
      }

      Section("Machine") {
        HStack {
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
        .sidebarTag(.attention, selection: selection)
        HStack {
          SidebarLabel(title: "Storage", icon: "internaldrive", selected: selection == .storage)
          Spacer()
          if autopilot.pressure != nil {
            Image(systemName: "exclamationmark.circle.fill").font(.system(size: 11)).foregroundStyle(Theme.warn)
              .help("Free disk is under the Stim budget")
          }
        }
        .sidebarTag(.storage, selection: selection)
      }
    }
    .scrollContentBackground(.hidden)
    .background(Theme.sidebar)
    .safeAreaInset(edge: .top) { brand }
  }

  private var brand: some View {
    HStack(spacing: 10) {
      if let logo = BrandAssets.logo(colorScheme) {
        Image(nsImage: logo).resizable().frame(width: 28, height: 28)
      }
      Text("Stim").font(Theme.heading(16))
      Spacer()
      filterMenu
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
  }

  private var filterMenu: some View {
    let filtered = !showsIdle || hidesUnprovisioned
    return Menu {
      Toggle("Live only", isOn: Binding(get: { !showsIdle }, set: { showsIdle = !$0 }))
      Toggle("Hide no-environment worktrees", isOn: $hidesUnprovisioned)
    } label: {
      Image(systemName: filtered ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
    .help(filtered ? "Filter on" : "Filter workspaces")
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

struct WorkspaceRow: View {
  var env: Workspace
  var selection: SidebarItem?

  var body: some View {
    HStack(spacing: 10) {
      StatusDot(color: env.live ? Theme.live : Theme.tertiary, filled: env.live)
      VStack(alignment: .leading, spacing: 1) {
        Text(env.names.title).lineLimit(1)
        Text(env.names.subtitle).font(Theme.body(11)).foregroundStyle(Theme.secondary).lineLimit(1)
      }
      Spacer()
      GitIndicator(git: env.worktree?.git)
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
  var selection: SidebarItem?

  var body: some View {
    let names = PathNames(path: worktree.path)
    HStack(spacing: 10) {
      StatusDot(color: Theme.tertiary, filled: false)
      VStack(alignment: .leading, spacing: 1) {
        Text(names.title).lineLimit(1)
        Text(worktree.branch ?? names.subtitle).font(Theme.body(11)).foregroundStyle(Theme.secondary).lineLimit(1)
      }
      Spacer()
      if worktree.git?.isNotable == true {
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
