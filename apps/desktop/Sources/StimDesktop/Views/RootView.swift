import StimKit
import SwiftUI

enum SidebarItem: Hashable {
  case wall
  case project(Project)
  case environment(String)
  case attention
}

struct RootView: View {
  @StateObject private var store = StatusStore()
  @State private var selection: SidebarItem? = .wall
  @State private var projectFilter: Project?

  var body: some View {
    NavigationSplitView {
      Sidebar(store: store, selection: $selection, projectFilter: projectFilter)
        .navigationSplitViewColumnWidth(min: 240, ideal: 272)
    } detail: {
      detail
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
    }
    .toolbar {
      ToolbarItem(placement: .primaryAction) { MachineSummary(store: store) }
    }
    .toolbarBackground(Theme.background, for: .windowToolbar)
    .tint(Theme.purple)
    .font(Theme.body())
    .foregroundStyle(Theme.text)
    .preferredColorScheme(.dark)
    .onAppear { store.start() }
    .onChange(of: selection) { _, item in
      switch item {
      case .wall: projectFilter = nil
      case .project(let project): projectFilter = project
      default: break
      }
    }
  }

  @ViewBuilder private var detail: some View {
    switch selection {
    case .environment(let path):
      if let env = store.payload?.environments.first(where: { $0.path == path }) {
        WorkspaceDetail(env: env)
      } else {
        EmptyState(title: "Workspace gone", message: "stim status no longer reports this workspace.")
      }
    case .attention:
      AttentionView(store: store)
    default:
      WallView(store: store, project: projectFilter, selection: $selection)
    }
  }
}

struct MachineSummary: View {
  @ObservedObject var store: StatusStore

  var body: some View {
    HStack(spacing: 18) {
      if let error = store.error {
        Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Theme.warn)
      }
      if let cap = store.payload?.capacity {
        HStack(spacing: 6) {
          StatusDot(color: Theme.live)
          Text("\(cap.liveCount) live")
        }
        HStack(spacing: 8) {
          Text("Memory").foregroundStyle(Theme.secondary)
          ProgressView(value: min(1, Double(cap.committedMb) / Double(max(1, cap.totalMemoryMb))))
            .tint(cap.overCapacity ? Theme.warn : Theme.lavender)
            .frame(width: 70)
          Text("\(formatGigabytes(mb: cap.committedMb)) / \(formatGigabytes(mb: cap.totalMemoryMb))")
            .font(Theme.mono())
        }
      }
      if let at = store.updatedAt {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          Text("\(max(0, Int(context.date.timeIntervalSince(at))))s ago")
            .font(Theme.mono())
            .foregroundStyle(Theme.tertiary)
        }
      }
    }
    .font(Theme.body(12))
    .padding(.horizontal, 10)
  }
}
