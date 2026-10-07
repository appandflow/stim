import Foundation

public enum StatusFilter: String, CaseIterable, Sendable {
  case live, idle, notSetUp, archived

  public var title: String {
    switch self {
    case .live: "Live"
    case .idle: "Idle"
    case .notSetUp: "Not set up"
    case .archived: "Archived"
    }
  }

  public static let all = Set(allCases)
  public static let defaultSelection: Set<StatusFilter> = [.live, .idle]

  public static func encode(_ statuses: Set<StatusFilter>) -> String {
    (try? String(decoding: JSONEncoder().encode(allCases.filter { statuses.contains($0) }.map(\.rawValue)), as: UTF8.self)) ?? ""
  }

  public static func decode(_ raw: String) -> Set<StatusFilter> {
    guard let values = try? JSONDecoder().decode([String].self, from: Data(raw.utf8)) else { return defaultSelection }
    return Set(values.compactMap(StatusFilter.init(rawValue:)))
  }

  public static func summary(_ statuses: Set<StatusFilter>) -> String {
    if statuses == all { return "All" }
    if statuses.isEmpty { return "None" }
    if statuses.count <= 2 { return allCases.filter { statuses.contains($0) }.map(\.title).joined(separator: ", ") }
    return "\(statuses.count) selected"
  }
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
  public var statuses: Set<StatusFilter> = StatusFilter.defaultSelection
  public var hiddenProjects: Set<String> = []
  public var grouping = SidebarGrouping.project
  public var sort = SidebarSort.name
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
  case archivedGroup([ArchivedWorkspace])
  case workspace(Workspace)
  case worktreeGroup(WorktreePage)
  case worktree(UnprovisionedWorktree)

  public var path: String {
    switch self {
    case .archived(let archive): return archive.projectRoot
    case .archivedGroup(let archives): return archives[0].projectRoot
    case .workspace(let env): return env.path
    case .worktreeGroup(let page): return page.id
    case .worktree(let worktree): return worktree.path
    }
  }

  public var id: String {
    if case .archived(let archive) = self { return "archive:\(archive.id)" }
    if case .archivedGroup(let archives) = self { return "archive-group:\(archives[0].id)" }
    return path
  }

  public var archiveProject: Project? {
    switch self {
    case .archived(let archive): archive.sidebarProject
    case .archivedGroup(let archives): archives[0].sidebarProject
    default: nil
    }
  }

  public var status: StatusFilter {
    switch self {
    case .archived, .archivedGroup: .archived
    case .worktree: .notSetUp
    default: active ? .live : .idle
    }
  }

  var active: Bool {
    switch self {
    case .workspace(let env): return env.isActive
    case .worktreeGroup(let page): return page.apps.contains(where: \.isActive)
    case .worktree, .archived, .archivedGroup: return false
    }
  }

  var memoryMb: Int {
    switch self {
    case .workspace(let env): return env.memoryMb ?? 0
    case .worktreeGroup(let page): return page.apps.reduce(0) { $0 + ($1.memoryMb ?? 0) }
    case .worktree, .archived, .archivedGroup: return 0
    }
  }

  var lastActivityAt: Date? {
    switch self {
    case .workspace(let env): return env.lastActivityAt
    case .worktreeGroup(let page): return page.apps.compactMap(\.lastActivityAt).max()
    case .archived(let archive): return parseTimestamp(archive.removedAt)
    case .archivedGroup(let archives): return parseTimestamp(archives[0].removedAt)
    case .worktree: return nil
    }
  }

  var sortName: String {
    switch self {
    case .archived(let archive): return archive.title.lowercased()
    case .archivedGroup(let archives): return archives[0].title.lowercased()
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

/// A project and its visible rows. `summary` counts every current worktree, including filtered ones;
/// for a project with only archived history, it counts the archive rows.
public struct ProjectTree: Hashable, Sendable {
  public var summary: ProjectSummary
  public var entries: [SidebarEntry]

  /// Whether every visible row is an archive, which opens the project by default.
  public var showsOnlyArchives: Bool { !entries.isEmpty && entries.allSatisfy { $0.status == .archived } }
  /// Whether the project has no current worktree and appears only for its archives.
  public var isArchiveOnly = false
}

/// The sidebar grouped by project. A project left with no rows is omitted unless `showsEmptyProjects` is set.
public func sidebarTrees(
  environments: [Workspace], unprovisioned: [UnprovisionedWorktree], project: (String) -> Project,
  options: SidebarOptions, archived: [ArchivedWorkspace] = []
) -> [ProjectTree] {
  let grouped = Dictionary(grouping: visibleEntries(environments, unprovisioned, project, options, archived)) {
    if let archiveProject = $0.archiveProject { return archiveProject }
    return project($0.path)
  }
  let summaries = projectSummaries(environments: environments, unprovisioned: unprovisioned, project: project)
    .filter { !options.hiddenProjects.contains($0.project.root) }
  let known = Set(summaries.map(\.project))
  let trees =
    (summaries.map { ProjectTree(summary: $0, entries: orderedEntries(grouped[$0.project] ?? [], options, project)) }
    + grouped.filter { !known.contains($0.key) }.map { key, entries in
      ProjectTree(
        summary: ProjectSummary(project: key, live: 0, total: entries.count), entries: orderedEntries(entries, options, project),
        isArchiveOnly: true)
    }).filter { options.showsEmptyProjects || !$0.entries.isEmpty }
  func key(_ tree: ProjectTree) -> (activity: Date?, memory: Int) {
    let current = tree.entries.filter { $0.status != .archived }
    let entries = current.isEmpty ? tree.entries : current
    return (entries.compactMap(\.lastActivityAt).max(), entries.reduce(0) { $0 + $1.memoryMb })
  }
  return trees.map { ($0, key($0)) }.sorted { a, b in
    let (x, y) = (a.1, b.1)
    switch options.sort {
    case .lastActivity where x.activity != y.activity: return newer(x.activity, y.activity)
    case .memory where x.memory != y.memory: return x.memory > y.memory
    default:
      return (a.0.summary.project.name.lowercased(), a.0.summary.project.root)
        < (b.0.summary.project.name.lowercased(), b.0.summary.project.root)
    }
  }.map(\.0)
}

/// The sidebar as one list, with no grouping.
public func sidebarList(
  environments: [Workspace], unprovisioned: [UnprovisionedWorktree], project: (String) -> Project,
  options: SidebarOptions, archived: [ArchivedWorkspace] = []
) -> [SidebarEntry] {
  let entries = visibleEntries(environments, unprovisioned, project, options, archived)
  return orderedEntries(entries, options, project)
}

private func visibleEntries(
  _ environments: [Workspace], _ unprovisioned: [UnprovisionedWorktree], _ project: (String) -> Project,
  _ options: SidebarOptions, _ archived: [ArchivedWorkspace]
) -> [SidebarEntry] {
  var archiveEntries: [SidebarEntry] = []
  if options.statuses.contains(.archived) {
    let archives = ArchivedWorkspace.newestFirst(archived)
      .filter { !options.hiddenProjects.contains($0.sidebarProject.root) }
    var groups: [[ArchivedWorkspace]] = []
    for archive in archives {
      if let index = groups.firstIndex(where: {
        $0[0].sidebarProject == archive.sidebarProject && $0[0].worktreeRoot == archive.worktreeRoot
          && !$0.contains(where: { $0.projectRoot == archive.projectRoot })
      }) {
        groups[index].append(archive)
      } else {
        groups.append([archive])
      }
    }
    archiveEntries = groups.map { $0.count > 1 ? .archivedGroup($0) : .archived($0[0]) }
  }
  let worktrees = options.statuses.contains(.notSetUp) ? unprovisioned.map(SidebarEntry.worktree) : []
  let apps = WorktreePage.groups(environments: environments).map { page in
    page.isUnified ? SidebarEntry.worktreeGroup(page) : .workspace(page.apps[0])
  }
  return (apps + worktrees).filter { entry in
    guard !options.hiddenProjects.contains(project(entry.path).root) else { return false }
    return options.statuses.contains(entry.status)
  } + archiveEntries
}

public func sidebarStatusCounts(
  environments: [Workspace], unprovisioned: [UnprovisionedWorktree], project: (String) -> Project,
  options: SidebarOptions, archived: [ArchivedWorkspace] = []
) -> [StatusFilter: Int] {
  var options = options
  options.statuses = Set(StatusFilter.allCases)
  var counts = Dictionary(uniqueKeysWithValues: StatusFilter.allCases.map { ($0, 0) })
  for entry in visibleEntries(environments, unprovisioned, project, options, archived) {
    counts[entry.status, default: 0] += 1
  }
  return counts
}

private func orderedEntries(
  _ entries: [SidebarEntry], _ options: SidebarOptions, _ project: (String) -> Project
) -> [SidebarEntry] {
  sorted(entries.filter { $0.status != .archived }, by: options.sort, project: project)
    + entries.filter { $0.status == .archived }
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
