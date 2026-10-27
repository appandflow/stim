import Foundation

/// A project with nothing running, as the Overview lists it.
public struct IdleProject: Hashable, Identifiable, Sendable {
  public var project: Project
  public var workspaces: Int
  public var lastActivity: Date?
  public var pullRequest: PullRequestFacts?
  public var failedBuild: LastBuild?
  public var errors: Int

  public var id: String { project.id }
}

public enum Overview {
  public static func visibleIdle(_ items: [IdleProject], expanded: Bool, limit: Int) -> (shown: [IdleProject], hidden: Int) {
    guard !expanded, items.count > limit else { return (items, 0) }
    return (Array(items.prefix(limit)), items.count - limit)
  }

  /// The projects without an active workspace, most recently used first, then by name.
  public static func idleProjects(
    summaries: [ProjectSummary], environments: [Workspace], project: (String) -> Project
  ) -> [IdleProject] {
    let byProject = Dictionary(grouping: environments, by: { project($0.path) })
    return summaries.filter { !$0.hasActive }.map { summary in
      let envs = byProject[summary.project] ?? []
      let failed = envs.flatMap { env in [env.lastBuilds?.ios, env.lastBuilds?.android].compactMap { $0 } }
        .filter { $0.status != "ok" }
        .max { (parseTimestamp($0.startedAt) ?? .distantPast) < (parseTimestamp($1.startedAt) ?? .distantPast) }
      return IdleProject(
        project: summary.project, workspaces: summary.total,
        lastActivity: envs.compactMap(lastActivity).max(),
        pullRequest: envs.compactMap(\.worktree?.pullRequest).first { $0.state == "open" || $0.state == "draft" },
        failedBuild: failed, errors: envs.reduce(0) { $0 + ($1.logs?.errorsSinceMarker ?? 0) })
    }.sorted {
      let (a, b) = ($0.lastActivity ?? .distantPast, $1.lastActivity ?? .distantPast)
      return a == b ? $0.project.name.lowercased() < $1.project.name.lowercased() : a > b
    }
  }

  static func lastActivity(_ env: Workspace) -> Date? {
    var dates: [Date] = []
    for build in [env.lastBuilds?.ios, env.lastBuilds?.android].compactMap({ $0 }) {
      if let date = parseTimestamp(build.finishedAt ?? build.startedAt) { dates.append(date) }
    }
    for session in (env.agents ?? []) + (env.endedAgents ?? []) {
      if let date = [session.endedAt, session.lastActiveAt].compactMap({ $0 }).compactMap(parseTimestamp).max() {
        dates.append(date)
      }
    }
    return dates.max()
  }

}

/// What a project's files say it can use, for the sidebar tips.
public struct ProjectCapabilities: Equatable, Sendable {
  public var eas = false
  public var macos = false

  public init(eas: Bool = false, macos: Bool = false) {
    self.eas = eas
    self.macos = macos
  }

  /// Looks in the project root and in each folder directly under `apps`: an `eas.json`, and either a `.stim.json`
  /// with a `macos` section or a `Package.swift` declaring an executable target.
  public static func detect(root: String, fileManager: FileManager = .default) -> ProjectCapabilities {
    let apps = ((try? fileManager.contentsOfDirectory(atPath: root + "/apps")) ?? []).sorted().map { root + "/apps/" + $0 }
    var result = ProjectCapabilities()
    for folder in [root] + apps {
      if fileManager.fileExists(atPath: folder + "/eas.json") { result.eas = true }
      let stim = (try? String(contentsOfFile: folder + "/.stim.json", encoding: .utf8)) ?? ""
      let package = (try? String(contentsOfFile: folder + "/Package.swift", encoding: .utf8)) ?? ""
      if stim.contains("\"macos\"") || package.contains(".executableTarget") { result.macos = true }
    }
    return result
  }
}

/// Which of a project's worktrees its page lists.
public enum ProjectScope: Sendable {
  case active, all
}

public enum ProjectPage {
  public enum Content: Equatable, Sendable {
    /// The worktrees to list, active ones first.
    case worktrees([Workspace])
    /// The project has worktrees but none is active, and the scope is `active`.
    case noneActive
    case empty
  }

  /// A project page shows all worktrees only for the project the user opened from an idle row; any other
  /// navigation starts at the active workspaces.
  public static func scope(of project: Project, showingAll: Project?) -> ProjectScope {
    showingAll == project ? .all : .active
  }

  public static func content(environments: [Workspace], scope: ProjectScope) -> Content {
    let active = environments.filter(\.isActive)
    switch scope {
    case .active: return active.isEmpty ? (environments.isEmpty ? .empty : .noneActive) : .worktrees(active)
    case .all: return environments.isEmpty ? .empty : .worktrees(active + environments.filter { !$0.isActive })
    }
  }
}
