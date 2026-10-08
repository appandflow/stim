import Foundation

/// One card of the Active worktrees page: a worktree and its apps, grouped by the sidebar's `WorktreePage` identity.
public struct WallCard: Identifiable, Sendable {
  public struct App: Identifiable, Sendable {
    public var workspace: Workspace
    /// The app's folder inside the worktree, or the folder name for an app at the worktree root.
    public var label: String
    public var devices: [DeviceRef]
    public var id: String { workspace.path }
  }

  public var page: WorktreePage
  public var apps: [App]
  public var id: String { page.id }
  public var isMultiApp: Bool { apps.count > 1 }

  public static func cards(environments: [Workspace]) -> [WallCard] {
    WorktreePage.groups(environments: environments).map { page in
      WallCard(
        page: page,
        apps: page.apps.map { env in
          App(
            workspace: env, label: WorktreePage.project(env),
            devices: env.orderedDevices.filter { $0.isRunning || env.runningBuild(for: $0) != nil })
        })
    }
  }
}
