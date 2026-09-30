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
  /// Each `offload.machines` entry's state; nil from a `stim` older than the field.
  public var buildMachines: [BuildMachineStatus]?
}

/// The first `stim ...` command a doctor fix names in backticks, such as `stim doctor --fix --platform android`.
public func doctorRemedy(_ fix: String?) -> String? {
  guard let fix else { return nil }
  let spans = fix.split(separator: "`", omittingEmptySubsequences: false).enumerated().filter { $0.offset % 2 == 1 }
  return spans.map { String($0.element) }.first { $0.hasPrefix("stim ") }
}

/// Needs-attention items for the doctor findings that need project judgment, one per `cost` finding.
public func setupItems(_ reports: [DoctorReport]) -> [NeedsAttentionItem] {
  reports.flatMap { report in
    report.findings.filter { $0.level == "cost" }.map { finding in
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

/// One workspace per app to run `stim doctor` in: the app's folder in the project's own checkout when status lists
/// it, else the first worktree workspace of that folder. Only listed workspaces qualify, because doctor records its
/// run in the Stim project registry and would add an unlisted checkout to `stim status`.
public func doctorCheckouts(_ environments: [Workspace], project: (String) -> Project) -> [DoctorCheckout] {
  let listed = Set(environments.map(\.path))
  var order: [String] = []
  var chosen: [String: DoctorCheckout] = [:]
  for env in environments {
    let root = project(env.path).root
    var source = env.path
    if let worktree = env.worktree?.path, worktree != root, env.path == worktree || env.path.hasPrefix(worktree + "/") {
      source = root + env.path.dropFirst(worktree.count)
    }
    if chosen[source] == nil { order.append(source) }
    if chosen[source] == nil || (env.path == source && listed.contains(source)) {
      chosen[source] = DoctorCheckout(path: env.path, repository: root)
    }
  }
  return order.compactMap { chosen[$0] }
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
