import Foundation

public enum StatusFilter: String, CaseIterable, Sendable {
  case all, live, idle, archived

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
  public var sort = SidebarSort.name
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

/// A sidebar row: an archive, one app, a multi-app worktree, or a worktree with no environment.
public enum SidebarEntry: Hashable, Identifiable, Sendable {
  case archived(ArchivedWorkspace)
  case workspace(Workspace)
  case worktreeGroup(WorktreePage)
  case worktree(UnprovisionedWorktree)

  public var path: String {
    switch self {
    case .archived(let archive): return archive.projectRoot
    case .workspace(let env): return env.path
    case .worktreeGroup(let page): return page.id
    case .worktree(let worktree): return worktree.path
    }
  }

  public var id: String {
    if case .archived(let archive) = self { return "archive:\(archive.id)" }
    return path
  }

  var active: Bool {
    switch self {
    case .workspace(let env): return env.isActive
    case .worktreeGroup(let page): return page.apps.contains(where: \.isActive)
    case .worktree, .archived: return false
    }
  }

  var memoryMb: Int {
    switch self {
    case .workspace(let env): return env.memoryMb ?? 0
    case .worktreeGroup(let page): return page.apps.reduce(0) { $0 + ($1.memoryMb ?? 0) }
    case .worktree, .archived: return 0
    }
  }

  var lastActivityAt: Date? {
    switch self {
    case .workspace(let env): return env.lastActivityAt
    case .worktreeGroup(let page): return page.apps.compactMap(\.lastActivityAt).max()
    case .archived(let archive): return parseTimestamp(archive.removedAt)
    case .worktree: return nil
    }
  }

  var sortName: String {
    switch self {
    case .archived(let archive): return archive.title.lowercased()
    case .workspace(let env): return env.names.title.lowercased()
    case .worktreeGroup(let page): return page.apps[0].names.title.lowercased()
    case .worktree(let worktree): return worktree.names.title.lowercased()
    }
  }
}

extension Workspace {
  /// The newest time `stim status` records for this workspace: device activity, a driver attaching, the
  /// supervisor or a remote session starting, a build starting, changing phase, or ending, or a warm starting or
  /// finishing.
  public var lastActivityAt: Date? {
    var stamps: [String?] = [supervisor?.startedAt, build?.startedAt, build?.phaseStartedAt, phaseSince]
    for device in devices { stamps += [device.activity?.lastActivityAt, device.activity?.driver?.since] }
    stamps += (remoteDevices ?? []).map(\.startedAt)
    stamps += [lastBuilds?.ios, lastBuilds?.android].compactMap { $0.map { $0.finishedAt ?? $0.startedAt } }
    return stamps.compactMap { $0.flatMap(parseTimestamp) }.max()
  }
}

/// A project in the sidebar tree and its visible rows. `summary` counts every worktree, including hidden ones.
public struct ProjectTree: Hashable, Sendable {
  public var summary: ProjectSummary
  public var entries: [SidebarEntry]
}

/// The sidebar grouped by project. A project left with no rows is omitted unless `showsEmptyProjects` is set.
public func sidebarTrees(
  environments: [Workspace], unprovisioned: [UnprovisionedWorktree], project: (String) -> Project,
  options: SidebarOptions, archived: [ArchivedWorkspace] = []
) -> [ProjectTree] {
  let grouped = Dictionary(grouping: visibleEntries(environments, unprovisioned, project, options, archived)) {
    if case .archived(let archive) = $0 { return archive.sidebarProject }
    return project($0.path)
  }
  if options.status == .archived {
    return grouped.map { key, entries in
      ProjectTree(summary: ProjectSummary(project: key, live: 0, total: entries.count), entries: entries)
    }.sorted {
      ($0.summary.project.name.lowercased(), $0.summary.project.root) < (
        $1.summary.project.name.lowercased(), $1.summary.project.root
      )
    }
  }
  let trees = projectSummaries(environments: environments, unprovisioned: unprovisioned, project: project)
    .filter { !options.hiddenProjects.contains($0.project.root) }
    .map { ProjectTree(summary: $0, entries: sorted(grouped[$0.project] ?? [], by: options.sort, project: project)) }
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
  options: SidebarOptions, archived: [ArchivedWorkspace] = []
) -> [SidebarEntry] {
  let entries = visibleEntries(environments, unprovisioned, project, options, archived)
  return options.status == .archived ? entries : sorted(entries, by: options.sort, project: project)
}

private func visibleEntries(
  _ environments: [Workspace], _ unprovisioned: [UnprovisionedWorktree], _ project: (String) -> Project,
  _ options: SidebarOptions, _ archived: [ArchivedWorkspace]
) -> [SidebarEntry] {
  if options.status == .archived {
    return ArchivedWorkspace.newestFirst(archived)
      .filter { !options.hiddenProjects.contains($0.sidebarProject.root) }.map(SidebarEntry.archived)
  }
  let worktrees = options.showsNoEnvironment ? unprovisioned.map(SidebarEntry.worktree) : []
  let apps = WorktreePage.groups(environments: environments).map { page in
    page.isUnified ? SidebarEntry.worktreeGroup(page) : .workspace(page.apps[0])
  }
  return (apps + worktrees).filter { entry in
    guard !options.hiddenProjects.contains(project(entry.path).root) else { return false }
    switch options.status {
    case .all: return true
    case .live: return entry.active
    case .idle: return !entry.active
    case .archived: return false
    }
  }
}

private func sorted(
  _ entries: [SidebarEntry], by sort: SidebarSort, project: (String) -> Project
) -> [SidebarEntry] {
  return entries.sorted { a, b in
    if sort == .name {
      let (x, y) = (project(a.path).name.lowercased(), project(b.path).name.lowercased())
      if x != y { return x < y }
    }
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
