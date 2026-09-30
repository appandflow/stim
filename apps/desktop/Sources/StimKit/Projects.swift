import Foundation

/// The repository a workspace belongs to. Every worktree of a repository
/// shares one project, wherever the worktree lives on disk.
public struct Project: Hashable, Identifiable, Sendable {
  public var root: String
  public var name: String { (root as NSString).lastPathComponent }
  public var id: String { root }

  public init(root: String) {
    self.root = root
  }

  /// The project for a `git rev-parse --git-common-dir` result: the checkout
  /// that owns `.git`, or the directory itself for a bare repository.
  public init(gitCommonDir: String) {
    let trimmed = gitCommonDir.hasSuffix("/") ? String(gitCommonDir.dropLast()) : gitCommonDir
    root = trimmed.hasSuffix("/.git") ? String(trimmed.dropLast(5)) : trimmed
  }

  /// The project for a workspace git cannot answer for, such as a path that no
  /// longer exists: the directory above a `.worktrees` folder, else the path.
  public init(fallbackFor path: String) {
    let parts = path.split(separator: "/", omittingEmptySubsequences: false)
    if let i = parts.lastIndex(of: ".worktrees"), i > 0 {
      root = parts[..<i].joined(separator: "/")
    } else {
      root = path
    }
  }

  public static func resolve(workspace path: String) -> Project {
    let request = ProcessRequest("/usr/bin/git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"])
    guard let result = try? request.runBlocking(), result.status == 0 else { return Project(fallbackFor: path) }
    let dir = result.stdoutText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard dir.hasPrefix("/") else { return Project(fallbackFor: path) }
    return Project(gitCommonDir: (dir as NSString).resolvingSymlinksInPath)
  }
}

private let remoteURLPattern = try! NSRegularExpression(
  pattern:
    #"^(?:https?://(?:[^/@]+@)?[^/]+/|ssh://(?:[^/@]+@)?[^/]+/|(?:[^/@:]+@)?[^/:]+:)([^/]+)/([^/]+?)(?:\.git)?/?$"#,
  options: .caseInsensitive)

/// "owner/name", lowercased, parsed out of a git remote URL, or nil when it doesn't match: https, `ssh://`, or
/// scp-like (`[user@]host:owner/name`, which also covers an `~/.ssh/config` host alias in place of `user@host`).
public func parseRemoteRepo(_ url: String) -> String? {
  let range = NSRange(url.startIndex..., in: url)
  guard let match = remoteURLPattern.firstMatch(in: url, range: range), match.numberOfRanges == 3,
    let ownerRange = Range(match.range(at: 1), in: url), let nameRange = Range(match.range(at: 2), in: url)
  else { return nil }
  return "\(url[ownerRange].lowercased())/\(url[nameRange].lowercased())"
}

/// "owner/name" of every git remote configured at `path`, lowercased. `git remote -v` (not `git config
/// --get-regexp`) so a pushurl and an `insteadOf` rewrite both count.
public func localRemoteRepos(at path: String) -> Set<String> {
  guard let result = try? ProcessRequest("/usr/bin/git", ["-C", path, "remote", "-v"]).runBlocking(),
    result.status == 0
  else { return [] }
  let text = result.stdoutText
  var repos = Set<String>()
  for line in text.split(separator: "\n") {
    let fields = line.split(separator: "\t", maxSplits: 1)
    guard fields.count == 2, let url = fields[1].split(separator: " ").first,
      let repo = parseRemoteRepo(String(url))
    else { continue }
    repos.insert(repo)
  }
  return repos
}

/// The branch checked out at `path`, or nil for a detached HEAD or a path git cannot read.
public func currentBranch(at path: String) -> String? {
  guard let result = try? ProcessRequest("/usr/bin/git", ["-C", path, "branch", "--show-current"]).runBlocking(),
    result.status == 0
  else { return nil }
  let branch = result.stdoutText.trimmingCharacters(in: .whitespacesAndNewlines)
  return branch.isEmpty ? nil : branch
}

/// A project in the sidebar and how many of its workspaces are live. `total`
/// counts its workspaces and its worktrees with no environment.
public struct ProjectSummary: Hashable, Sendable {
  public var project: Project
  public var live: Int
  public var total: Int
  /// Workspaces `stim worktree warm` is preparing or has just prepared.
  public var settingUp = 0
  /// Workspaces the Live filter shows: live, building or setting up.
  public var active = 0

  public var hasActive: Bool { active > 0 }
}

/// Groups workspaces and worktrees with no environment by project, the ones
/// with workspaces the Live filter shows first, then by name.
public func projectSummaries(
  environments: [Workspace], unprovisioned: [UnprovisionedWorktree], project: (String) -> Project
) -> [ProjectSummary] {
  var summaries: [Project: ProjectSummary] = [:]
  func add(_ path: String, live: Bool, settingUp: Bool = false, active: Bool = false) {
    let key = project(path)
    summaries[key, default: ProjectSummary(project: key, live: 0, total: 0)].total += 1
    if live { summaries[key]?.live += 1 } else if settingUp { summaries[key]?.settingUp += 1 }
    if active { summaries[key]?.active += 1 }
  }
  for env in environments { add(env.path, live: env.live, settingUp: env.isSettingUp, active: env.isActive) }
  for worktree in unprovisioned { add(worktree.path, live: false) }
  return summaries.values.sorted {
    ($0.hasActive ? 0 : 1, $0.project.name.lowercased()) < ($1.hasActive ? 0 : 1, $1.project.name.lowercased())
  }
}

/// A title for each project root: the folder name, with the enclosing folders added for as many levels as it
/// takes to tell apart projects whose folders share a name, such as `app (work)` and `app (code)`.
public func projectTitles(roots: [String]) -> [String: String] {
  var titles: [String: String] = [:]
  let byName = Dictionary(grouping: Set(roots)) { ($0 as NSString).lastPathComponent }
  for (name, group) in byName {
    guard group.count > 1 else {
      titles[group[0]] = name
      continue
    }
    let parents = group.map { root in (root, (root as NSString).deletingLastPathComponent.split(separator: "/").map(String.init))
    }
    var depth = 1
    func qualifier(_ parents: [String], _ depth: Int) -> String { parents.suffix(depth).joined(separator: "/") }
    while depth < (parents.map(\.1.count).max() ?? 0),
      Set(parents.map { qualifier($0.1, depth) }).count < parents.count
    {
      depth += 1
    }
    for (root, components) in parents {
      let qualified = qualifier(components, depth)
      titles[root] = qualified.isEmpty ? name : "\(name) (\(qualified))"
    }
  }
  return titles
}
