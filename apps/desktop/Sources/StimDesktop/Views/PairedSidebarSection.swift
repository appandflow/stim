import StimKit
import StimStores
import SwiftUI

struct PairedSidebarSection: View {
  var entry: PairedServers.Entry
  var session: ServerSession?
  var status: PairedStatus?
  var options: SidebarOptions
  var selection: SidebarItem?
  @ObservedObject var state: PairedViewState

  private var id: String { entry.id }
  private var owner: ServerOwner { .paired(entry.id) }
  private var name: String { session?.name ?? entry.pairing?.name ?? "" }
  private var environments: [Workspace] { status?.payload?.environments ?? [] }

  var body: some View {
    let expanded = !state.collapsedServers.contains(id)
    Section {
      if expanded {
        if let line = connectionLine { line }
        let trees = pairedSidebarTrees(environments: environments, options: options, hidden: hiddenPaths)
        switch options.grouping {
        case .project:
          ForEach(trees, id: \.summary.project) { tree in
            DisclosureGroup(isExpanded: isExpanded(tree)) {
              rows(tree.entries, subtitle: nil)
            } label: {
              PairedProjectRow(summary: tree.summary)
            }
          }
        case .none:
          ForEach(trees, id: \.summary.project) { tree in rows(tree.entries, subtitle: tree.summary.project.name) }
        }
        if trees.isEmpty, status?.payload != nil {
          InlineEmpty("No workspaces").font(.stim(.callout))
        }
      }
    } header: {
      PairedServerHeader(
        name: name, entry: entry, active: environments.filter(\.isActive).count, expanded: expanded,
        toggle: {
          if expanded { state.collapsedServers.insert(id) } else { state.collapsedServers.remove(id) }
        })
    }
  }

  private var hiddenPaths: Set<String> {
    Set(state.hidden.filter { $0.owner == owner }.map(\.path))
  }

  @ViewBuilder private func rows(_ entries: [SidebarEntry], subtitle: String?) -> some View {
    ForEach(entries.flatMap(Self.workspaces), id: \.path) { env in
      PairedWorkspaceRow(
        env: env, key: WorkspaceKey(owner: owner, path: env.path), place: subtitle.map { [$0] } ?? [],
        showsGit: options.showsGitStatus, selection: selection, state: state)
    }
  }

  private static func workspaces(_ entry: SidebarEntry) -> [Workspace] {
    switch entry {
    case .workspace(let env): return [env]
    case .worktreeGroup(let page): return page.apps
    case .archived, .archivedGroup, .worktree: return []
    }
  }

  private var connectionLine: Text? {
    let offline = session?.offlineSince.map {
      "Offline since \($0.formatted(date: .omitted, time: .shortened))"
    }
    if case .open = entry.connection {
      guard status?.delivering == false, status?.payload != nil else { return nil }
      return Text(offline ?? "Not updating").font(.stim(.caption)).foregroundStyle(Palette.tertiary)
    }
    let text = [entry.status.title, status?.payload == nil ? nil : offline].compactMap { $0 }
      .joined(separator: " \u{00B7} ")
    return Text(text).font(.stim(.caption)).foregroundStyle(Color(entry.status.tone))
  }

  private func isExpanded(_ tree: ProjectTree) -> Binding<Bool> {
    let key = owner.scoped(tree.summary.project.root)
    return Binding(
      get: { state.expandedProjects[key] ?? tree.summary.hasActive },
      set: { state.expandedProjects[key] = $0 })
  }
}

private struct PairedServerHeader: View {
  var name: String
  var entry: PairedServers.Entry
  var active: Int
  var expanded: Bool
  var toggle: () -> Void

  var body: some View {
    Button(action: toggle) {
      HStack(spacing: Space.sm) {
        StatusDot(color: Color(entry.status.tone), size: 6, label: entry.status.title)
        Text(verbatim: name.uppercased()).textStyle(.caption, weight: .bold).tracking(0.6)
          .foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle)
        Pill(tone: .neutral, size: .small) { Text(accessLabel) }
        Spacer(minLength: 0)
        if !expanded, active > 0 {
          Text("\(active) active").font(.stim(.caption)).foregroundStyle(Palette.tertiary).fixedSize()
        }
        Image(systemName: expanded ? "chevron.down" : "chevron.right").iconFont(IconSize.small)
          .foregroundStyle(Palette.tertiary).accessibilityHidden(true)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Text(verbatim: [name, entry.status.title, accessLabel].joined(separator: ", ")))
    .accessibilityHint(expanded ? "Collapses this machine's workspaces" : "Shows this machine's workspaces")
    .help(Text(verbatim: "Workspaces \(name) controls, as its stim-server reports them"))
  }

  private var accessLabel: String {
    entry.pairing?.capabilities.contains("control") == true ? "View and Control" : "View Only"
  }
}

private struct PairedProjectRow: View {
  var summary: ProjectSummary

  var body: some View {
    HStack(spacing: Space.md) {
      Image(systemName: "folder")
        .foregroundStyle(summary.hasActive ? Palette.primary : Palette.tertiary)
        .accessibilityHidden(true)
      Text(verbatim: summary.project.name).lineLimit(1).truncationMode(.middle)
      Spacer()
      if summary.live == 0 {
        Text("\(summary.total)").font(.stim(.caption)).foregroundStyle(Palette.tertiary).fixedSize()
      }
    }
  }
}

private struct PairedWorkspaceRow: View {
  var env: Workspace
  var key: WorkspaceKey
  var place: [String]
  var showsGit: Bool
  var selection: SidebarItem?
  @ObservedObject var state: PairedViewState

  var body: some View {
    let isHidden = state.hidden.contains(key)
    TimelineView(.everyMinute) { _ in
      WorkspaceRowContent(env: env, now: Date(), place: place, showsGit: showsGit, openLogs: nil, isHidden: isHidden)
    }
    .sidebarTag(.pairedWorkspace(key), selection: selection)
    .contextMenu {
      Button(isHidden ? "Unhide" : "Hide", systemImage: isHidden ? "eye" : "eye.slash") {
        if isHidden { state.hidden.remove(key) } else { state.hidden.insert(key) }
      }
    }
  }
}
