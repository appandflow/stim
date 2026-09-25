import Foundation

public enum StatusFilter: String, CaseIterable, Sendable {
  case all, live, idle

  public var title: String { rawValue.capitalized }
}

public enum SidebarGrouping: String, CaseIterable, Sendable {
  case project, none

  public var title: String { rawValue.capitalized }
}

public enum SidebarSort: String, CaseIterable, Sendable {
  case lastActivity, name, memory

  public var title: String {
    switch self {
    case .lastActivity: return "Last activity"
    case .name: return "Name"
    case .memory: return "Memory"
    }
  }
}

/// The sidebar's view options. `hiddenProjects` holds project roots, so a project seen for the first time shows.
public struct SidebarOptions: Equatable, Sendable {
  public var status = StatusFilter.all
  public var hiddenProjects: Set<String> = []
  public var grouping = SidebarGrouping.project
  public var sort = SidebarSort.lastActivity
  public var showsNoEnvironment = true
  public var showsGitStatus = true
  public var showsEmptyProjects = false

  public init() {}

  /// Whether any option differs from the defaults, counting only hidden projects that still exist.
  public func differsFromDefaults(projects: [Project]) -> Bool {
    var shown = self
    shown.hiddenProjects.formIntersection(projects.map(\.root))
    return shown != SidebarOptions()
  }

  public static func encode(hiddenProjects: Set<String>) -> String {
    (try? String(decoding: JSONEncoder().encode(hiddenProjects.sorted()), as: UTF8.self)) ?? ""
  }

  public static func decode(hiddenProjects: String) -> Set<String> {
    Set((try? JSONDecoder().decode([String].self, from: Data(hiddenProjects.utf8))) ?? [])
  }
}

/// A sidebar row: a workspace, or a worktree with no environment.
public enum SidebarEntry: Hashable, Identifiable, Sendable {
  case workspace(Workspace)
  case worktree(UnprovisionedWorktree)

  public var path: String {
    switch self {
    case .workspace(let env): return env.path
    case .worktree(let worktree): return worktree.path
    }
  }

  public var id: String { path }

  public var live: Bool {
    if case .workspace(let env) = self { return env.live }
    return false
  }

  var memoryMb: Int {
    if case .workspace(let env) = self { return env.memoryMb ?? 0 }
    return 0
  }

  var lastActivityAt: Date? {
    if case .workspace(let env) = self { return env.lastActivityAt }
    return nil
  }

  var sortName: String { PathNames(path: path).title.lowercased() }
}

extension Workspace {
  /// The newest time `stim status` records for this workspace: device activity, a driver attaching, the
  /// supervisor or a remote session starting, or a build starting, changing phase, or ending.
  public var lastActivityAt: Date? {
    var stamps: [String?] = [supervisor?.startedAt, build?.startedAt, build?.phaseStartedAt]
    for device in devices { stamps += [device.activity?.lastActivityAt, device.activity?.driver?.since] }
    stamps += (remoteDevices ?? []).map(\.startedAt)
    stamps += [lastBuilds?.ios, lastBuilds?.android].compactMap { $0.map { $0.finishedAt ?? $0.startedAt } }
    return stamps.compactMap { $0.flatMap(parseTimestamp) }.max()
  }
}

/// A project in the sidebar tree and its visible rows. `summary` counts every workspace, including hidden ones.
public struct ProjectTree: Hashable, Sendable {
  public var summary: ProjectSummary
  public var entries: [SidebarEntry]
}

/// The sidebar grouped by project. A project left with no rows is omitted unless `showsEmptyProjects` is set.
public func sidebarTrees(
  environments: [Workspace], unprovisioned: [UnprovisionedWorktree], project: (String) -> Project,
  options: SidebarOptions
) -> [ProjectTree] {
  let grouped = Dictionary(grouping: visibleEntries(environments, unprovisioned, project, options)) {
    project($0.path)
  }
  let trees = projectSummaries(environments: environments, unprovisioned: unprovisioned, project: project)
    .filter { !options.hiddenProjects.contains($0.project.root) }
    .map { ProjectTree(summary: $0, entries: sorted(grouped[$0.project] ?? [], by: options.sort)) }
    .filter { options.showsEmptyProjects || !$0.entries.isEmpty }
  func key(_ tree: ProjectTree) -> (activity: Date?, memory: Int) {
    (tree.entries.compactMap(\.lastActivityAt).max(), tree.entries.reduce(0) { $0 + $1.memoryMb })
  }
  return trees.map { ($0, key($0)) }.sorted { a, b in
    let (x, y) = (a.1, b.1)
    switch options.sort {
    case .lastActivity where x.activity != y.activity: return newer(x.activity, y.activity)
    case .memory where x.memory != y.memory: return x.memory > y.memory
    default: return a.0.summary.project.name.lowercased() < b.0.summary.project.name.lowercased()
    }
  }.map(\.0)
}

/// The sidebar as one list, with no grouping.
public func sidebarList(
  environments: [Workspace], unprovisioned: [UnprovisionedWorktree], project: (String) -> Project,
  options: SidebarOptions
) -> [SidebarEntry] {
  sorted(visibleEntries(environments, unprovisioned, project, options), by: options.sort)
}

private func visibleEntries(
  _ environments: [Workspace], _ unprovisioned: [UnprovisionedWorktree], _ project: (String) -> Project,
  _ options: SidebarOptions
) -> [SidebarEntry] {
  let worktrees = options.showsNoEnvironment ? unprovisioned.map(SidebarEntry.worktree) : []
  return (environments.map(SidebarEntry.workspace) + worktrees).filter { entry in
    guard !options.hiddenProjects.contains(project(entry.path).root) else { return false }
    switch options.status {
    case .all: return true
    case .live: return entry.live
    case .idle: return !entry.live
    }
  }
}

private func sorted(_ entries: [SidebarEntry], by sort: SidebarSort) -> [SidebarEntry] {
  entries.sorted { a, b in
    switch sort {
    case .lastActivity where a.lastActivityAt != b.lastActivityAt: return newer(a.lastActivityAt, b.lastActivityAt)
    case .memory where a.memoryMb != b.memoryMb: return a.memoryMb > b.memoryMb
    default: return (a.sortName, a.path) < (b.sortName, b.path)
    }
  }
}

private func newer(_ a: Date?, _ b: Date?) -> Bool {
  guard let a else { return false }
  guard let b else { return true }
  return a > b
}
