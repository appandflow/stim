import AppKit
import StimKit

@MainActor
final class StatusStore: ObservableObject {
  static let pollInterval: TimeInterval = 10

  @Published private(set) var payload: StatusPayload?
  @Published private(set) var error: String?
  @Published private(set) var updatedAt: Date?
  @Published private(set) var projects: [String: Project] = [:] {
    didSet { projectTitleMap = projectTitles(roots: projects.values.map(\.root)) }
  }
  private var projectTitleMap: [String: String] = [:]
  @Published private(set) var watching = false
  /// The directory `stim` keeps its state in; `~/.stim` until the CLI's environment is known.
  private(set) var stimHome = "\(NSHomeDirectory())/.stim"
  @Published private(set) var doctor: [String: Fetched<DoctorReport>] = [:]

  private let cli: Task<StimCLI, Never>
  private var started = false
  private var terminating = false
  private var watcher: Process?
  private var watchStderr: [String] = []
  private var backoff = RestartBackoff()
  private var pollTimer: Timer?
  private var inFlight = false
  private var refreshPending = false
  private var issued = 0
  private var shown = 0
  private var doctorRuns: [String: DoctorRun] = [:]
  private var doctorCheckedAt: Date?
  private var doctorStartedAt: Date?
  private static let doctorTimeout: TimeInterval = 10 * 60
  private static let doctorCheckInterval: TimeInterval = 60

  init(cli: Task<StimCLI, Never>) {
    self.cli = cli
    Task { stimHome = await cli.value.stimHome }
  }

  func start() {
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

  func refresh() {
    guard !inFlight else {
      refreshPending = true
      return
    }
    inFlight = true
    let sequence = nextSequence()
    let cli = cli
    Task {
      let result = await Result.awaiting { try await cli.value.status() }
      inFlight = false
      show(result, sequence: sequence)
      if refreshPending {
        refreshPending = false
        refresh()
      }
    }
  }

  private func startWatch() {
    let cli = cli
    Task { [weak self] in
      let cli = await cli.value
      guard let self, !self.terminating else { return }
      let startedAt = Date()
      self.watchStderr = []
      do {
        self.watcher = try cli.stream(
          StatusWatch.arguments, cwd: NSHomeDirectory(),
          onLine: { [weak self] line in
            let decoded: Result<StatusPayload, Error>? =
              line.channel == .stdout
              ? Result { try JSONDecoder().decode(StatusPayload.self, from: Data(line.text.utf8)) } : nil
            DispatchQueue.main.async {
              MainActor.assumeIsolated {
                guard let self else { return }
                if let decoded {
                  self.show(decoded, sequence: self.nextSequence())
                } else {
                  self.watchStderr.append(line.text)
                }
              }
            }
          },
          onExit: { [weak self] status in
            DispatchQueue.main.async {
              MainActor.assumeIsolated { self?.watchExited(status, ranFor: Date().timeIntervalSince(startedAt)) }
            }
          })
        self.watching = true
      } catch {
        self.error = error.localizedDescription
        self.restartWatch(ranFor: 0)
      }
    }
  }

  private func watchExited(_ status: Int32, ranFor duration: TimeInterval) {
    watcher = nil
    watching = false
    guard !terminating else { return }
    if StatusWatch.isUnsupported(stderr: watchStderr) {
      startPolling()
      return
    }
    if status != 0 { error = watchStderr.last ?? StimCLI.Failure.exited(status).localizedDescription }
    restartWatch(ranFor: duration)
  }

  private func restartWatch(ranFor duration: TimeInterval) {
    let delay = backoff.delay(afterRunning: duration)
    Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.startWatch() }
    }
  }

  private func startPolling() {
    guard pollTimer == nil else { return }
    refresh()
    pollTimer = Timer.scheduledTimer(withTimeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.refresh() }
    }
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
      let resolved = Dictionary(missing.map { ($0, Project.resolve(workspace: $0)) }, uniquingKeysWith: { first, _ in first })
      await MainActor.run {
        self.projects.merge(reported) { old, _ in old }
        self.projects.merge(resolved) { old, _ in old }
        guard sequence > self.shown else { return }
        self.shown = sequence
        var payload = payload
        for i in payload.environments.indices {
          payload.environments[i].project = self.project(ofPath: payload.environments[i].path)
        }
        self.payload = payload
        self.error = nil
        self.updatedAt = Date()
        self.checkDoctor()
      }
    }
  }

  func project(of env: Workspace) -> Project {
    project(ofPath: env.path)
  }

  func title(of project: Project) -> String {
    projectTitleMap[project.root] ?? projectTitles(roots: Array(projectTitleMap.keys) + [project.root])[project.root]
      ?? project.name
  }

  func names(ofPath path: String) -> PathNames {
    if let env = payload?.environments.first(where: { $0.path == path }) { return env.names }
    if let worktree = payload?.unprovisionedWorktrees?.first(where: { $0.path == path }) { return worktree.names }
    return PathNames(path: path, project: projects[path])
  }

  func project(ofPath path: String) -> Project {
    projects[path] ?? Project(fallbackFor: path)
  }

  func environments(in project: Project?) -> [Workspace] {
    let all = payload?.environments ?? []
    guard let project else { return all }
    return all.filter { self.project(of: $0) == project }
  }

  var projectList: [ProjectSummary] {
    projectSummaries(
      environments: payload?.environments ?? [], unprovisioned: payload?.unprovisionedWorktrees ?? [],
      project: project(ofPath:))
  }

  func sidebarTrees(_ options: SidebarOptions) -> [ProjectTree] {
    StimKit.sidebarTrees(
      environments: payload?.environments ?? [], unprovisioned: payload?.unprovisionedWorktrees ?? [],
      project: project(ofPath:), options: options)
  }

  func sidebarList(_ options: SidebarOptions) -> [SidebarEntry] {
    StimKit.sidebarList(
      environments: payload?.environments ?? [], unprovisioned: payload?.unprovisionedWorktrees ?? [],
      project: project(ofPath:), options: options)
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
  func doctorChanged(in path: String) {
    doctorRuns[path] = nil
    doctorCheckedAt = nil
    checkDoctor()
  }

  /// What only a person can act on; `lowestVolume` is the fullest volume Stim uses, when measured.
  func attention(lowestVolume: DiskVolume?) -> [NeedsAttentionItem] {
    let minutes = UserDefaults.standard.integer(forKey: AppPreferences.Key.remoteSessionMinutes)
    let setup =
      setupItems(doctor.keys.sorted().compactMap { doctor[$0]?.value })
      + doctorFailureItems(doctor.compactMapValues(\.error))
    return needsAttention(
      payload?.environments ?? [], volumes: lowestVolume.map { [Double($0.freeBytes)] }, now: Date(),
      stuckMinutes: 15, easSessionMinutes: minutes > 0 ? minutes : 30) + setup
  }
}
