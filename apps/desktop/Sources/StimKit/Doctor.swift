import Foundation

/// The payload printed by `stim doctor --json`.
public struct DoctorReport: Decodable, Hashable, Sendable {
  public struct Finding: Decodable, Hashable, Sendable {
    public var code: String?
    /// `cost` for setup that makes worktrees slow or invalid, `note` for information.
    public var level: String
    public var title: String
    public var detail: String
    public var fix: String?
  }

  public var project: String
  public var findings: [Finding]
  /// Each `remote.machines` entry's state; nil from a `stim` older than the field.
  public var remoteMachines: [BuildMachineStatus]?
  public var deviceHosts: [BuildMachineStatus]?
}

/// The first `stim ...` command a doctor fix names in backticks, such as `stim doctor --fix --platform android`.
public func doctorRemedy(_ fix: String?) -> String? {
  guard let fix else { return nil }
  let spans = fix.split(separator: "`", omittingEmptySubsequences: false).enumerated().filter { $0.offset % 2 == 1 }
  return spans.map { String($0.element) }.first { $0.hasPrefix("stim ") }
}

extension DoctorReport {
  public var costFindings: [Finding] { findings.filter { $0.level == "cost" } }

  /// The report `stim doctor --json` printed, or nil when `stdout` is not one.
  public static func decode(_ stdout: Data) -> DoctorReport? {
    try? JSONDecoder().decode(DoctorReport.self, from: stdout)
  }
}

extension DoctorReport.Finding {
  /// The `stim doctor --fix` command this finding's fix names, to run in `cwd`; nil when the fix needs project
  /// judgment or another command.
  public func repairCommand(cwd: String) -> StimCommand? {
    guard let words = doctorRemedy(fix)?.split(separator: " ").map(String.init),
      words.dropFirst().first == "doctor", words.contains("--fix")
    else { return nil }
    return StimCommand(Array(words.dropFirst()), cwd: cwd)
  }
}

/// The `stim doctor` finding code for a folder that is not a React Native or Expo app.
public let notAnAppFindingCode = "not-an-app"

/// Needs-attention items for the doctor findings that need project judgment, one per `cost` finding.
public func setupItems(_ reports: [DoctorReport]) -> [NeedsAttentionItem] {
  reports.flatMap { report in
    report.costFindings.map { finding in
      NeedsAttentionItem(
        id: "setup-\(finding.code ?? finding.title):\(report.project)", category: .attention, severity: "warning",
        workspace: report.project, body: "Setup: \(finding.title)", remedy: doctorRemedy(finding.fix))
    }
  }
}

/// A needs-attention item for each checkout, by path, whose last `stim doctor` run failed, with the failure.
public func doctorFailureItems(_ failures: [String: String]) -> [NeedsAttentionItem] {
  failures.keys.sorted().map { path in
    NeedsAttentionItem(
      id: "doctor-failed:\(path)", category: .attention, severity: "warning", workspace: path,
      body: "stim doctor failed: \(failures[path] ?? "")", remedy: "stim doctor")
  }
}

/// A workspace to run `stim doctor` in, and the repository it belongs to.
public struct DoctorCheckout: Hashable, Sendable {
  public var path: String
  public var repository: String
}

/// Whether `path` is a scratch folder, such as an agent's temporary worktree, that is gone or stale soon.
public func isScratchPath(_ path: String) -> Bool {
  ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].contains { path == $0 || path.hasPrefix($0 + "/") }
}

/// Whether `path` is inside a git checkout that still exists: a `.git` folder, or a `.git` file whose gitdir is there.
public func isGitCheckout(_ path: String) -> Bool {
  let fileManager = FileManager.default
  var directory = URL(fileURLWithPath: path)
  while true {
    let dotGit = directory.appendingPathComponent(".git")
    var isFolder: ObjCBool = false
    if fileManager.fileExists(atPath: dotGit.path, isDirectory: &isFolder) {
      if isFolder.boolValue { return true }
      guard let text = try? String(contentsOf: dotGit, encoding: .utf8),
        let line = text.split(separator: "\n").first(where: { $0.hasPrefix("gitdir:") })
      else { return false }
      let target = line.dropFirst("gitdir:".count).trimmingCharacters(in: .whitespaces)
      return fileManager.fileExists(atPath: URL(fileURLWithPath: target, relativeTo: directory).path)
    }
    let parent = directory.deletingLastPathComponent()
    if parent.path == directory.path { return false }
    directory = parent
  }
}

/// One workspace per app to run `stim doctor` in, the most recently active app first: the app's folder in the
/// project's own checkout when status lists it, else the first worktree workspace of that folder. Only listed
/// workspaces qualify, because doctor records its run in the Stim project registry and would add an unlisted
/// checkout to `stim status`. A workspace in a scratch folder, or outside a git checkout, never qualifies.
public func doctorCheckouts(
  _ environments: [Workspace], project: (String) -> Project, isCheckout: (String) -> Bool = isGitCheckout
) -> [DoctorCheckout] {
  doctorCheckoutsBySource(environments, project: project, isCheckout: isCheckout).map(\.checkout)
}

/// The checkout doctor runs in for `workspace`'s app, else the first one.
public func doctorCheckout(
  for workspace: String?, in environments: [Workspace], project: (String) -> Project,
  isCheckout: (String) -> Bool = isGitCheckout
) -> DoctorCheckout? {
  let checkouts = doctorCheckoutsBySource(environments, project: project, isCheckout: isCheckout)
  let source = environments.first { $0.path == workspace }.map { doctorSource(of: $0, project: project) }
  return (checkouts.first { $0.source == source } ?? checkouts.first)?.checkout
}

private func doctorSource(of env: Workspace, project: (String) -> Project) -> String {
  let root = project(env.path).root
  if let worktree = env.worktree?.path, worktree != root, env.path == worktree || env.path.hasPrefix(worktree + "/") {
    return root + env.path.dropFirst(worktree.count)
  }
  return env.path
}

private func doctorCheckoutsBySource(
  _ environments: [Workspace], project: (String) -> Project, isCheckout: (String) -> Bool
) -> [(source: String, checkout: DoctorCheckout)] {
  let usable = environments.filter { !isScratchPath($0.path) && isCheckout($0.path) }
  let listed = Set(usable.map(\.path))
  var order: [String] = []
  var chosen: [String: DoctorCheckout] = [:]
  var activity: [String: Date] = [:]
  for env in usable {
    let source = doctorSource(of: env, project: project)
    if chosen[source] == nil { order.append(source) }
    if chosen[source] == nil || (env.path == source && listed.contains(source)) {
      chosen[source] = DoctorCheckout(path: env.path, repository: project(env.path).root)
    }
    if let at = env.lastActivityAt, at > activity[source] ?? .distantPast { activity[source] = at }
  }
  let ranked = order.enumerated().sorted { a, b in
    let (x, y) = (activity[a.element], activity[b.element])
    return x == y ? a.offset < b.offset : (x ?? .distantPast) > (y ?? .distantPast)
  }
  return ranked.compactMap { _, source in chosen[source].map { (source, $0) } }
}

/// When Stim Desktop last ran `stim doctor` in a checkout.
public struct DoctorRun: Hashable, Sendable {
  public var at: Date
  /// What `stim --version` printed then.
  public var version: String?
  /// The newest modification time of the checkout's setup files then.
  public var inputsChangedAt: Date?

  public init(at: Date, version: String?, inputsChangedAt: Date?) {
    self.at = at
    self.version = version
    self.inputsChangedAt = inputsChangedAt
  }

  /// `guide`'s staleness limit for a doctor run.
  public static let maxAge: TimeInterval = 7 * 24 * 60 * 60

  /// Whether doctor is due: it never ran here, ran with another stim, ran more than a week ago, or a setup file
  /// changed since.
  public static func due(_ last: DoctorRun?, version: String?, inputsChangedAt: Date?, now: Date) -> Bool {
    guard let last else { return true }
    if last.version != version || now.timeIntervalSince(last.at) > maxAge { return true }
    guard let inputsChangedAt else { return false }
    return last.inputsChangedAt.map { inputsChangedAt > $0 } ?? true
  }
}

/// The files whose change can change doctor's findings for a checkout in `repository`.
public func doctorInputs(checkout: String, repository: String) -> [String] {
  let app = [
    "package.json", "app.json", "app.config.js", "app.config.ts", "ios/Podfile", "ios/Podfile.lock",
    "android/build.gradle", "android/gradle.properties",
  ]
  let locks = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lock", "bun.lockb"]
  let dirs = checkout == repository ? [checkout] : [checkout, repository]
  return app.map { checkout + "/" + $0 } + dirs.flatMap { dir in locks.map { dir + "/" + $0 } }
}

/// The newest modification time among `paths` that exist.
public func newestModification(_ paths: [String]) -> Date? {
  paths.compactMap { (try? FileManager.default.attributesOfItem(atPath: $0))?[.modificationDate] as? Date }.max()
}
