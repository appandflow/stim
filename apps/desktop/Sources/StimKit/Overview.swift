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
  public static let archivedShown = 5

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

  public static func recentlyArchived(_ archives: [ArchivedWorkspace]) -> [ArchivedWorkspace] {
    Array(ArchivedWorkspace.newestFirst(archives).prefix(archivedShown))
  }
}

/// A feature the Overview suggests trying, with a prompt the user can hand to an agent.
public enum TryThisTip: String, CaseIterable, Codable, Sendable {
  case easProfile, easSimulator, remoteBuild, hostedSimulator, macos, physicalDevice, web, logs

  public var title: String {
    switch self {
    case .easProfile: "Run on an EAS development build"
    case .easSimulator: "Use a simulator hosted by EAS"
    case .remoteBuild: "Build on another Mac"
    case .hostedSimulator: "Run the simulator on another Mac"
    case .macos: "Run your Mac app with Stim"
    case .physicalDevice: "Run on your phone"
    case .web: "Open the web build with stim web"
    case .logs: "Ask for just the errors"
    }
  }

  public var detail: String {
    switch self {
    case .easProfile: "Install a completed EAS development build instead of compiling it here."
    case .easSimulator: "Run the app on a cloud simulator when this Mac has no room for one. EAS bills the session."
    case .remoteBuild: "Compile on a second Mac and keep this one free."
    case .hostedSimulator: "Run the app's simulator on a second Mac and watch it here."
    case .macos: "Stim builds the Swift package as an isolated development app and captures its logs."
    case .physicalDevice: "Install a Debug build on a cabled or Wi-Fi paired iPhone or Android phone."
    case .web: "Capture page errors and failed requests in the same log as the native apps."
    case .logs: "One timeline for Metro, the app, the build and the device."
    }
  }

  /// The sidebar tip that covers the same feature, so the two never show it at once.
  public var sidebarTopic: TipTopic? {
    switch self {
    case .remoteBuild: .buildMachine
    case .hostedSimulator: .hostedSimulators
    default: nil
    }
  }
}

public struct TryThisInputs: Sendable {
  /// `remote.machines`; nil when the setting could not be read.
  public var remoteMachines: [String]?
  public var hasEASProject = false
  public var hasMacosTarget = false
  public var workspaces: [Workspace] = []

  public init() {}
}

public enum TryThis {
  public static let limit = 3

  public static func applicable(_ tip: TryThisTip, inputs: TryThisInputs) -> Bool {
    let remoteMacsSet = inputs.remoteMachines?.isEmpty == false
    switch tip {
    case .easProfile, .easSimulator: return inputs.hasEASProject
    case .remoteBuild, .hostedSimulator: return inputs.remoteMachines != nil && !remoteMacsSet
    case .macos: return inputs.hasMacosTarget
    case .physicalDevice, .web, .logs: return true
    }
  }

  /// Whether the workspaces' own state shows the feature in use.
  public static func used(_ tip: TryThisTip, workspaces: [Workspace]) -> Bool {
    switch tip {
    case .easProfile: return false
    case .easSimulator: return workspaces.contains { $0.remoteDevices?.isEmpty == false }
    case .remoteBuild:
      return workspaces.contains(where: ranOnAnotherMac)
    case .hostedSimulator: return workspaces.contains { $0.ios?.host != nil }
    case .macos: return workspaces.contains { $0.macos != nil }
    case .physicalDevice: return workspaces.contains { $0.physicalDevices?.isEmpty == false }
    case .web: return workspaces.contains { $0.web != nil }
    case .logs: return false
    }
  }

  private static func ranOnAnotherMac(_ env: Workspace) -> Bool {
    var runs: [LastBuild] = []
    for last in [env.lastBuilds?.ios, env.lastBuilds?.android] {
      if let last { runs.append(last) }
    }
    for entry in (env.builds?.ios ?? []) + (env.builds?.android ?? []) { runs.append(entry.build) }
    return runs.contains { $0.offloadedTo != nil }
  }

  /// At most `limit` tips: the ones that apply and are neither dismissed nor the sidebar's current tip, with features
  /// the workspaces have not used first.
  public static func select(
    inputs: TryThisInputs, dismissed: Set<TryThisTip>, sidebarTopic: TipTopic?
  ) -> [TryThisTip] {
    let candidates = TryThisTip.allCases.filter {
      applicable($0, inputs: inputs) && !dismissed.contains($0)
        && ($0.sidebarTopic == nil || $0.sidebarTopic != sidebarTopic)
    }
    let inUse = candidates.filter { used($0, workspaces: inputs.workspaces) }
    let notInUse = candidates.filter { !inUse.contains($0) }
    return Array((notInUse + inUse).prefix(limit))
  }
}

public struct TryThisStore {
  private static let key = "tips.tryThis.dismissed"
  private let defaults: UserDefaults

  public init(defaults: UserDefaults) { self.defaults = defaults }

  public var dismissed: Set<TryThisTip> {
    Set((defaults.stringArray(forKey: Self.key) ?? []).compactMap(TryThisTip.init(rawValue:)))
  }

  public func dismiss(_ tip: TryThisTip) {
    defaults.set((dismissed.union([tip])).map(\.rawValue).sorted(), forKey: Self.key)
  }
}

/// What a project's files say it can use, for the Overview tips.
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
