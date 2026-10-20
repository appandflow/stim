import Foundation

/// The workspaces `stim status` lists for the first time since Stim Desktop started, each reported once.
public struct WorkspaceArrivals: Sendable {
  private var seen: Set<String>?

  public init() {}

  /// The first call records the workspaces already listed without reporting them, so a relaunch stays quiet. A path
  /// is reported at most once, even when it leaves the payload and comes back.
  public mutating func update(_ workspaces: [Workspace]) -> [Workspace] {
    guard var known = seen else {
      seen = Set(workspaces.map(\.path))
      return []
    }
    let arrived = workspaces.filter { known.insert($0.path).inserted && !Self.isScratch($0.path) }
    seen = known
    return arrived
  }

  /// Whether the path is under a temporary folder, where agents create throwaway worktrees.
  public static func isScratch(_ path: String) -> Bool {
    let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    return ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].contains {
      resolved == $0 || resolved.hasPrefix($0 + "/")
    }
  }

  /// The one card a new workspace gets.
  public static func cardKey(_ path: String) -> String { "workspace:\(path)" }

  /// The card's subtitle while the workspace's build runs.
  public static func buildLine(_ workspace: Workspace) -> String? {
    guard let build = workspace.build, build.isRunning else { return nil }
    return "Building \(platformName(build.platform))"
  }
}
