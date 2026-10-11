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

  private let cli: Task<StimCLI, Never>
  private let fetch: @Sendable () async throws -> StatusPayload
  private var started = false
  private var terminating = false
  private var watcher: Process?
  private var watchGeneration = 0
  private var restartTimer: Timer?
  private var serverActive = false
  private var serverConnection: (client: ServerClient, home: String)?
  private var shownWorkspace: String?
  private lazy var serverFeed = ServerStatusFeed(
    onPayload: { [weak self] in self?.accept($0) },
    onDelivering: { [weak self] in self?.serverDelivering($0) })
  private var watchStderr: [String] = []
  private var backoff = RestartBackoff()
  private var inFlight = false
  private var refreshPending = false
  private var issued = 0
  private var shown = 0
  private var doctorRuns: [String: DoctorRun] = [:]
  private var doctorCheckedAt: Date?
  private var doctorStartedAt: Date?
  private static let doctorTimeout: TimeInterval = 10 * 60
  private static let doctorCheckInterval: TimeInterval = 60

  init(
    cli: Task<StimCLI, Never>, stimHome expected: String? = nil,
    fetch: @escaping @Sendable () async throws -> StatusPayload
  ) {
    self.cli = cli
    self.fetch = fetch
    if let expected { self.stimHome = expected }
    Task {
      stimHome = await cli.value.stimHome
      LaunchMilestones.reach("cli-ready")
    }
  }

  /// `stimHome` is the Stim home to expect until the CLI resolves its own, so a server feed for it can show first.
  public convenience init(cli: Task<StimCLI, Never>, stimHome: String? = nil) {
    self.init(cli: cli, stimHome: stimHome, fetch: { try await cli.value.status() })
  }

  public func start() {
    guard !started else { return }
    started = true
    NotificationCenter.default.addObserver(
      forName: NSApplication.willTerminateNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.terminating = true
        self?.watcher?.terminate()
      }
    }
    startWatch()
  }

  public func refresh() {
    guard !inFlight else {
      refreshPending = true
      return
    }
    inFlight = true
    let sequence = nextSequence()
    let fetch = fetch
    Task {
      let result = await Result.awaiting { try await fetch() }
      inFlight = false
      show(result, sequence: sequence)
      if refreshPending {
        refreshPending = false
        refresh()
      }
    }
  }

  private func startWatch() {
    restartTimer = nil
    let cli = cli
    Task { [weak self] in
      let cli = await cli.value
      guard let self, !self.terminating, !self.serverActive, self.watcher == nil else { return }
      let startedAt = Date()
      self.watchStderr = []
      self.watchGeneration += 1
      let generation = self.watchGeneration
      do {
        self.watcher = try cli.stream(
          StatusWatch.arguments, cwd: NSHomeDirectory(),
          onLine: { [weak self] line in
            let decoded: Result<StatusPayload, Error>? =
              line.channel == .stdout
              ? Result { try decodeReporting(StatusPayload.self, from: Data(line.text.utf8), source: .cli) } : nil
            DispatchQueue.main.async {
              MainActor.assumeIsolated {
                guard let self, generation == self.watchGeneration else { return }
                if let decoded {
                  LaunchMilestones.reach("first-watch-payload")
                  self.accept(decoded)
                } else {
                  self.watchStderr.append(line.text)
                }
              }
            }
          },
          onExit: { [weak self] status in
            DispatchQueue.main.async {
              MainActor.assumeIsolated {
                guard let self, generation == self.watchGeneration else { return }
                self.watchExited(status, ranFor: Date().timeIntervalSince(startedAt))
              }
            }
          })
        self.watching = true
        LaunchMilestones.reach("watch-spawned")
      } catch {
        self.error = error.localizedDescription
        self.restartWatch(ranFor: 0)
      }
    }
  }

  private func watchExited(_ status: Int32, ranFor duration: TimeInterval) {
    watcher = nil
    watching = serverActive
    guard !terminating else { return }
    if status != 0 { error = watchStderr.last ?? StimCLI.Failure.exited(status).localizedDescription }
    restartWatch(ranFor: duration)
  }

  private func restartWatch(ranFor duration: TimeInterval) {
    let delay = backoff.delay(afterRunning: duration)
    DebugLog.info(.cli, "status watch restarts in \(delay)s after running \(Int(duration))s")
    restartTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.startWatch() }
    }
  }

  public func useServer(_ connection: (client: ServerClient, home: String)?) {
    serverConnection = connection
    syncServerFeed()
  }

  private func syncServerFeed() {
    serverFeed.use(readCapableServer(serverConnection, stimHome: stimHome))
  }

  func serverDelivering(_ delivering: Bool) {
    serverActive = delivering
    if delivering {
      restartTimer?.invalidate()
      restartTimer = nil
      watchGeneration += 1
      watcher?.terminate()
      watcher = nil
      watching = true
      return
    }
    watching = watcher != nil
    guard started, !terminating, watcher == nil else { return }
    backoff = RestartBackoff()
    startWatch()
  }

  /// Shows a payload the live watch delivered, which is newer than every refresh started before it.
  func accept(_ result: Result<StatusPayload, Error>) {
    show(result, sequence: nextSequence())
  }

  private func nextSequence() -> Int {
    issued += 1
    return issued
  }

  private func show(_ result: Result<StatusPayload, Error>, sequence: Int) {
    guard case .success(let payload) = result else {
      if sequence > shown, case .failure(let failure) = result { error = failure.localizedDescription }
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
          .cli,
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
    guard doctorStartedAt.map({ now.timeIntervalSince($0) > Self.doctorTimeout }) ?? true,
      doctorCheckedAt.map({ now.timeIntervalSince($0) >= Self.doctorCheckInterval }) ?? true,
      let payload
    else { return }
    doctorStartedAt = now
    doctorCheckedAt = now
    let checkouts = doctorCheckouts(payload.environments, project: project(ofPath:))
    let paths = Set(checkouts.map(\.path))
    doctor = doctor.filter { paths.contains($0.key) }
    let runs = doctorRuns
    let cli = cli
    Task.detached(priority: .utility) { [self] in
      let cli = await cli.value
      let version = await cli.versionOutput()
      for checkout in checkouts where FileManager.default.fileExists(atPath: checkout.path) {
        let inputs = newestModification(doctorInputs(checkout: checkout.path, repository: checkout.repository))
        guard DoctorRun.due(runs[checkout.path], version: version, inputsChangedAt: inputs, now: Date()) else { continue }
        let result = await Result.awaiting { try await cli.doctor(cwd: checkout.path) }
        let run = DoctorRun(at: Date(), version: version, inputsChangedAt: inputs)
        await recordDoctor(checkout.path, run: run, result: result)
      }
      await finishDoctor()
    }
  }

  private func recordDoctor(_ path: String, run: DoctorRun, result: Result<DoctorReport, any Error>) {
    doctorRuns[path] = run
    doctor[path, default: Fetched()].record(result)
  }

  private func finishDoctor() { doctorStartedAt = nil }

  /// Makes doctor due again in `path`, after a command there may have changed its findings.
  public func doctorChanged(in path: String) {
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
