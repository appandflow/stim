import Foundation

/// The kind of row the shared actions menu renders for. `workspaceMenuItems(for:)` decides the item set from
/// this alone; runtime specifics such as which external apps are installed are resolved by the caller.
public enum ActionRowKind: Hashable, Sendable {
  /// A provisioned workspace, with its dev server's current state and the platforms it can run on. `linkedWorktree`
  /// is false for the repository's source checkout, which `stim worktree remove` leaves in place.
  case workspace(metroRunning: Bool, platforms: [String], linkedWorktree: Bool)
  /// A worktree Stim has not registered an environment for.
  case worktree
  /// A project's row in the sidebar, which acts on every live workspace under it.
  case project
}

/// One item in the shared workspace/worktree/project actions menu. `nil` in `workspaceMenuItems(for:)` marks a
/// divider between sections.
public enum WorkspaceMenuItem: Hashable, Sendable {
  case openInEditor
  case openInTerminal
  case revealInFinder
  case copyPath
  case lastOutput
  /// `stim <platform>`: build if needed, install and launch on the workspace's device.
  case run(platform: String)
  case reload
  case startDevServer
  case stopDevServer
  case showLogs
  case warmWorktree
  case removeWorktree
  case stopAllLiveWorkspaces
}

/// The items the shared actions menu shows for `kind`, in order. The sidebar's row context menu and the
/// workspace detail's "..." menu both render this list, so the two never drift apart.
public func workspaceMenuItems(for kind: ActionRowKind) -> [WorkspaceMenuItem?] {
  switch kind {
  case .workspace(let metroRunning, let platforms, let linkedWorktree):
    return [
      .openInEditor, .openInTerminal, .revealInFinder, .copyPath, .lastOutput,
      nil,
    ] + platforms.map { .run(platform: $0) }
      + (platforms.contains("macos") && !platforms.contains { $0 == "ios" || $0 == "android" }
        ? [.stopDevServer, .showLogs]
        : [
          .reload, metroRunning ? .stopDevServer : .startDevServer, .showLogs,
        ]) + (linkedWorktree ? [nil, .removeWorktree] : [])
  case .worktree:
    return [
      .openInEditor, .openInTerminal, .revealInFinder, .copyPath,
      nil,
      .warmWorktree, .removeWorktree,
    ]
  case .project:
    return [.revealInFinder, .copyPath, nil, .stopAllLiveWorkspaces]
  }
}

/// Whether `stim worktree remove` would proceed instead of refusing over the worktree's own git state: no
/// uncommitted changes and no commits unpushed to its upstream. The CLI can still refuse for other reasons,
/// such as the branch being checked out elsewhere, that Desktop cannot see from `status`.
public func worktreeRemovalAllowed(git: WorktreeGit?) -> Bool {
  guard let git else { return true }
  return git.uncommitted == 0 && (git.ahead ?? 0) == 0
}

extension Workspace {
  /// The platforms with a device, a last build, macOS state or a running build.
  public var usedPlatforms: [String] {
    ["ios", "android", "macos", "web"].filter { platform in
      devices.contains { $0.platform == platform }
        || (["ios", "android"].contains(platform) && lastBuilds?.build(for: platform) != nil)
        || (platform == "macos" && macos != nil) || (build?.isRunning == true && build?.platform == platform)
    }
  }

  /// The platforms `stim status` reports for the app plus `usedPlatforms`; without the report (an older `stim`),
  /// the used ones, or iOS and Android when nothing is used.
  public var supportedPlatforms: [String] {
    let used = usedPlatforms
    let detected = platforms ?? (used.isEmpty ? ["ios", "android"] : [])
    return ["ios", "android", "macos", "web"].filter { detected.contains($0) || used.contains($0) }
  }

  /// The platforms Run offers.
  public var runPlatforms: [String] { supportedPlatforms }

  /// Whether `stim reload` can reach an app: the dev server runs and a local simulator or emulator is up with the
  /// app not known to be stopped. The web page reloads from its own tile, since a bare `stim reload` refuses when
  /// it and a native device both run.
  public var canReload: Bool {
    metro?.running == true
      && devices.contains { device in
        if case .remote = device { return false }
        if case .web = device { return false }
        return device.isRunning && !device.appStopped
      }
  }
}

public func platformName(_ platform: String) -> String {
  switch platform {
  case "ios": return "iOS"
  case "web": return "Web"
  case "macos": return "macOS"
  default: return "Android"
  }
}
