import StimKit
import SwiftUI

struct Sidebar: View {
  @ObservedObject var store: StatusStore
  @Binding var selection: SidebarItem?
  var projectFilter: Project?
  @AppStorage(AppPreferences.Key.showsIdleWorkspaces) private var showsIdle = true
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    let envs = store.environments(in: projectFilter)
    List(selection: $selection) {
      Label("All devices", systemImage: "square.grid.2x2")
        .sidebarTag(.wall, selection: selection)

      Section("Projects") {
        ForEach(store.projectList, id: \.project) { entry in
          HStack(spacing: 10) {
            Image(systemName: "folder")
              .foregroundStyle(entry.live > 0 ? Theme.primary : Theme.tertiary)
            Text(entry.project.name).lineLimit(1)
            Spacer()
            if entry.live > 0 {
              Text("\(entry.live) live").font(Theme.body(11)).foregroundStyle(Theme.live)
            } else {
              Text("\(entry.total)").font(Theme.body(11)).foregroundStyle(Theme.tertiary)
            }
          }
          .sidebarTag(.project(entry.project), selection: selection)
        }
      }

      Section(projectFilter.map { "Live in \($0.name)" } ?? "Live") {
        ForEach(envs.filter(\.live)) { env in WorkspaceRow(env: env, selection: selection) }
      }
      if showsIdle {
        Section("Idle") {
          ForEach(envs.filter { !$0.live }) { env in WorkspaceRow(env: env, selection: selection) }
        }
      }

      Section("Machine") {
        HStack {
          Label("Needs attention", systemImage: "exclamationmark.triangle")
          Spacer()
          let count = store.warningCount + (store.payload?.unprovisionedWorktrees?.count ?? 0)
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
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
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

extension View {
  fileprivate func sidebarTag(_ item: SidebarItem, selection: SidebarItem?) -> some View {
    tag(item).listRowBackground(item == selection ? Theme.selected : Color.clear)
  }
}
