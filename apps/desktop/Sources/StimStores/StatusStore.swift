import AppKit
import StimKit

@MainActor
public final class StatusStore: ObservableObject {
  @Published public private(set) var payload: StatusPayload? {
    didSet {
      newestArchiveCache = nil
      sidebarCache = nil
    }
  }
  @Published public private(set) var error: String?
  @Published public private(set) var updatedAt: Date?
  @Published public private(set) var projects: [String: Project] = [:] {
    didSet {
      projectTitleMap = projectTitles(roots: projects.values.map(\.root))
      sidebarCache = nil
    }
  }
  private var projectTitleMap: [String: String] = [:]
  private var newestArchiveCache: [ArchivedWorkspace]?
  private var sidebarCache: SidebarCache?
  @Published public private(set) var watching = false
  @Published public private(set) var stimHome = "\(NSHomeDirectory())/.stim" {
    didSet { syncServerFeed() }
  }
  @Published public private(set) var doctor: [String: Fetched<DoctorReport>] = [:]

  private var started = false
  private var payloadSource: (client: ServerClient, generation: Int, payload: StatusPayload)?
  private var serverConnection: (client: ServerClient, home: String)?
  private var shownWorkspace: String?
  private lazy var serverFeed = ServerStatusFeed(
    onPayload: { [weak self] result, client, generation in self?.accept(result, source: (client, generation)) },
    onDelivering: { [weak self] in self?.serverDelivering($0) })
  private var issued = 0
  private var shown = 0
  private var doctorRuns: [String: DoctorRun] = [:]
  private var doctorCheckedAt: Date?
  private var doctorTask: Task<Void, Never>?
  private var doctorGeneration = 0
  private static let doctorCheckInterval: TimeInterval = 60

  /// `stimHome` is the home to expect until the CLI environment resolves, so its server feed can show first.
  public init(cli: Task<StimCLI, Never>, stimHome expected: String? = nil) {
    if let expected { self.stimHome = expected }
    Task {
      stimHome = await cli.value.stimHome
      LaunchMilestones.reach("cli-ready")
    }
  }

  public func start() {
    guard !started else { return }
    started = true
    syncServerFeed()
  }

  public func refresh() {
    guard readCapableServer(serverConnection, stimHome: stimHome) != nil else {
      accept(.failure(ServerError(code: "not-connected", message: "Connect the Stim server to refresh workspaces.")))
      return
    }
    serverFeed.refresh()
  }

  public func useServer(_ connection: (client: ServerClient, home: String)?) {
    serverConnection = connection
    syncServerFeed()
  }

  private func syncServerFeed() {
    let client = readCapableServer(serverConnection, stimHome: stimHome)
    serverFeed.use(client)
    if client == nil {
      watching = false
      payloadSource = nil
      if started {
        accept(.failure(ServerError(code: "not-connected", message: "Connect the Stim server to refresh workspaces.")))
      }
    }
  }

  func serverDelivering(_ delivering: Bool) {
    watching = delivering
    if !delivering { payloadSource = nil }
  }

  func accept(_ result: Result<StatusPayload, Error>, source: (client: ServerClient, generation: Int)? = nil) {
    show(result, sequence: nextSequence(), source: source)
  }

  /// Resolves a shared link only from a snapshot of the current authenticated connection to this store's home.
  public func target(for link: SharedWorkspaceOpenRequest, connection: (client: ServerClient, home: String)?)
    -> (workspace: Workspace, device: DeviceRef?)?
  {
    guard let client = readCapableServer(connection, stimHome: stimHome),
      let source = payloadSource, source.client === client, source.generation == client.generation,
      case .open(let hello) = client.state, let homeId = hello.server.id
    else { return nil }
    guard let request = source.payload.request(for: link, homeId: homeId) else { return nil }
    return source.payload.target(of: request)
  }

  private func nextSequence() -> Int {
    issued += 1
    return issued
  }

  private func show(_ result: Result<StatusPayload, Error>, sequence: Int, source: (client: ServerClient, generation: Int)? = nil)
  {
    guard case .success(let payload) = result else {
      if sequence > shown, case .failure(let failure) = result {
        shown = sequence
        error = failure.localizedDescription
      }
      return
    }
    let known = projects
    let reported = Dictionary(
      (payload.unprovisionedWorktrees ?? []).compactMap { w in w.repository.map { (w.path, Project(root: $0)) } },
      uniquingKeysWith: { first, _ in first })
    let paths = payload.environments.map(\.path) + (payload.unprovisionedWorktrees ?? []).map(\.path)
    let missing = paths.filter { known[$0] == nil && reported[$0] == nil }
    Task.detached {
      let resolved = await withTaskGroup(of: (String, Project).self) { group in
        for path in Set(missing) { group.addTask { (path, Project.resolve(workspace: path)) } }
        return await group.reduce(into: [String: Project]()) { $0[$1.0] = $1.1 }
      }
      await MainActor.run {
        DebugLog.debug(
          .server,
          "status payload environments=\(payload.environments.count) unprovisioned=\(payload.unprovisionedWorktrees?.count ?? 0) archived=\(payload.archived?.count ?? 0) resolvedProjects=\(missing.count)"
        )
        var additions = reported.filter { self.projects[$0.key] == nil }
        additions.merge(resolved.filter { self.projects[$0.key] == nil }) { first, _ in first }
        if !additions.isEmpty { self.projects.merge(additions) { old, _ in old } }
        guard sequence > self.shown else { return }
        self.shown = sequence
        var payload = payload
        for i in payload.environments.indices {
          payload.environments[i].project = self.project(ofPath: payload.environments[i].path)
        }
        self.payloadSource = source.map { (client: $0.client, generation: $0.generation, payload: payload) }
        self.payload = payload
        self.followShown()
        self.error = nil
        self.updatedAt = Date()
        LaunchMilestones.reach(
          "first-payload-shown", "environments=\(payload.environments.count) archived=\(payload.archived?.count ?? 0)")
        self.checkDoctor()
      }
    }
  }

  /// Follows the full environment of `path`, the workspace a screen shows, instead of its summary; nil for none.
  public func show(workspace path: String?) {
    guard path != shownWorkspace else { return }
    shownWorkspace = path
    followShown()
  }

  private func followShown() {
    var paths = Set(payload?.environments.filter { $0.tutorial != nil }.map(\.path) ?? [])
    if let shownWorkspace { paths.insert(shownWorkspace) }
    serverFeed.follow(paths)
  }

  public func project(of env: Workspace) -> Project {
    project(ofPath: env.path)
  }

  public func title(of project: Project) -> String {
    projectTitleMap[project.root] ?? projectTitles(roots: Array(projectTitleMap.keys) + [project.root])[project.root]
      ?? project.name
  }

  public func names(ofPath path: String) -> PathNames {
    if let env = payload?.environments.first(where: { $0.path == path }) { return env.names }
    if let worktree = payload?.unprovisionedWorktrees?.first(where: { $0.path == path }) { return worktree.names }
    return PathNames(path: path, project: projects[path])
  }

  public func project(ofPath path: String) -> Project {
    projects[path] ?? Project(fallbackFor: path)
  }

  public func environments(in project: Project?) -> [Workspace] {
    let all = payload?.environments ?? []
    guard let project else { return all }
    return all.filter { self.project(of: $0) == project }
  }

  public var projectList: [ProjectSummary] {
    projectSummaries(
      environments: payload?.environments ?? [], unprovisioned: payload?.unprovisionedWorktrees ?? [],
      project: project(ofPath:))
  }

  /// The payload's archives, newest first.
  public var newestArchives: [ArchivedWorkspace] {
    if let newestArchiveCache { return newestArchiveCache }
    let newest = ArchivedWorkspace.newestFirst(payload?.archived ?? [])
    newestArchiveCache = newest
    return newest
  }

  public func sidebarTrees(_ options: SidebarOptions) -> [ProjectTree] {
    var cache = sidebar(options)
    if let trees = cache.trees { return trees }
    let trees = StimKit.sidebarTrees(
      visible: cache.visible, environments: payload?.environments ?? [],
      unprovisioned: payload?.unprovisionedWorktrees ?? [], project: project(ofPath:), options: options)
    cache.trees = trees
    sidebarCache = cache
    return trees
  }

  public func sidebarList(_ options: SidebarOptions) -> [SidebarEntry] {
    var cache = sidebar(options)
    if let list = cache.list { return list }
    let list = StimKit.sidebarList(visible: cache.visible, project: project(ofPath:), options: options)
    cache.list = list
    sidebarCache = cache
    return list
  }

  public func sidebarStatusCounts(_ options: SidebarOptions) -> [StatusFilter: Int] {
    sidebar(options).counts
  }

  private func sidebar(_ options: SidebarOptions) -> SidebarCache {
    if let sidebarCache, sidebarCache.options == options { return sidebarCache }
    let entries = sidebarEntries(
      environments: payload?.environments ?? [], unprovisioned: payload?.unprovisionedWorktrees ?? [],
      project: project(ofPath:), options: options, newestArchives: newestArchives)
    let cache = SidebarCache(
      options: options, visible: visibleSidebarEntries(entries, options),
      counts: StimKit.sidebarStatusCounts(entries, hidden: options.hiddenWorkspaces))
    sidebarCache = cache
    return cache
  }

  private func checkDoctor() {
    let now = Date()
    guard doctorTask == nil,
      doctorCheckedAt.map({ now.timeIntervalSince($0) >= Self.doctorCheckInterval }) ?? true,
      let payload, let client = readCapableServer(serverConnection, stimHome: stimHome),
      case .open(let hello) = client.state
    else { return }
    doctorCheckedAt = now
    let checkouts = doctorCheckouts(payload.environments, project: project(ofPath:))
    let paths = Set(checkouts.map(\.path))
    doctor = doctor.filter { paths.contains($0.key) }
    let runs = doctorRuns
    let generation = doctorGeneration
    let version = hello.server.stim
    doctorTask = Task.detached(priority: .utility) { [self] in
      for checkout in checkouts where FileManager.default.fileExists(atPath: checkout.path) {
        guard !Task.isCancelled else { break }
        let inputs = newestModification(doctorInputs(checkout: checkout.path, repository: checkout.repository))
        guard DoctorRun.due(runs[checkout.path], version: version, inputsChangedAt: inputs, now: Date()) else { continue }
        let result = await Result.awaiting {
          try await readDoctor(cwd: checkout.path, client: client)
        }
        let run = DoctorRun(at: Date(), version: version, inputsChangedAt: inputs)
        await recordDoctor(checkout.path, run: run, result: result, generation: generation)
      }
      await finishDoctor(generation: generation)
    }
  }

  private func recordDoctor(_ path: String, run: DoctorRun, result: Result<DoctorReport, any Error>, generation: Int) {
    guard generation == doctorGeneration, !Task.isCancelled else { return }
    if case .success = result { doctorRuns[path] = run }
    doctor[path, default: Fetched()].record(result)
  }

  private func readDoctor(cwd: String, client: ServerClient) async throws -> DoctorReport {
    try Task.checkCancellation()
    guard case .open(let hello) = client.state, hello.features?.contains("desktop-reports") == true else {
      throw ServerError(code: "unsupported", message: "Update the local stim-server to read setup reports.")
    }
    _ = try await client.request("desktop.reports.invalidate", [:])
    let result = try await client.request("desktop.reports.get", ["report": .string("doctor"), "cwd": .string(cwd)])
    guard case .object(let snapshot) = result, snapshot["pending"] == .bool(false), let value = snapshot["value"] else {
      throw ServerError(code: "bad-response", message: "The local stim-server did not return a completed setup report.")
    }
    return try decodeReporting(DoctorReport.self, from: value, source: .server)
  }

  private func finishDoctor(generation: Int) {
    if generation == doctorGeneration { doctorTask = nil }
  }

  /// Makes doctor due again in `path`, after a command there may have changed its findings.
  public func doctorChanged(in path: String) {
    doctorGeneration += 1
    doctorTask?.cancel()
    doctorTask = nil
    doctorRuns[path] = nil
    doctorCheckedAt = nil
    checkDoctor()
  }

  /// What only a person can act on; `lowestVolume` is the fullest volume Stim uses, when measured.
  public func attention(lowestVolume: DiskVolume?) -> [NeedsAttentionItem] {
    let minutes = UserDefaults.standard.integer(forKey: AppPreferences.Key.remoteSessionMinutes)
    let setup =
      setupItems(doctor.keys.sorted().compactMap { doctor[$0]?.value })
      + doctorFailureItems(doctor.compactMapValues(\.error))
    return needsAttention(
      payload?.environments ?? [], volumes: lowestVolume.map { [Double($0.freeBytes)] }, now: Date(),
      stuckMinutes: 15, easSessionMinutes: minutes > 0 ? minutes : 30) + setup
  }
}

private struct SidebarCache {
  var options: SidebarOptions
  var visible: [SidebarEntry]
  var counts: [StatusFilter: Int]
  var trees: [ProjectTree]?
  var list: [SidebarEntry]?
}
