import Foundation

public struct NotSetUpApp: Hashable, Sendable {
  public var path: String
  public var label: String?
  public var platforms: [String]

  public init(path: String, label: String?, platforms: [String]) {
    self.path = path
    self.label = label
    self.platforms = platforms
  }
}

public func notSetUpApps(
  for worktree: UnprovisionedWorktree, environments: [Workspace], project: (String) -> Project
) -> [NotSetUpApp] {
  let repository = project(worktree.path)
  var apps: [String: NotSetUpApp] = [:]
  for env in environments where project(env.path) == repository {
    let root = env.worktree?.path ?? repository.root
    guard env.path == root || env.path.hasPrefix(root + "/") else { continue }
    let relative = pathInCheckout(env.path, worktree: root)
    let path = relative.map { worktree.path + "/" + $0 } ?? worktree.path
    let platforms = Set((apps[path]?.platforms ?? []) + (env.runPlatforms.isEmpty ? ["ios", "android"] : env.runPlatforms))
    apps[path] = NotSetUpApp(
      path: path, label: relative, platforms: ["ios", "android", "macos", "web"].filter { platforms.contains($0) })
  }
  if apps.isEmpty { return [NotSetUpApp(path: worktree.path, label: nil, platforms: ["ios", "android"])] }
  return apps.values.sorted { ($0.label ?? "") < ($1.label ?? "") }
}

public func setUpSteps(_ arguments: [String], app: NotSetUpApp) -> [StimCommand] {
  [StimCommand(["worktree", "warm"], cwd: app.path), StimCommand(arguments, cwd: app.path)]
}
