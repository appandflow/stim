import AppKit
import StimKit

@MainActor
final class StatusStore: ObservableObject {
  static let pollInterval: TimeInterval = 10

  @Published private(set) var payload: StatusPayload?
  @Published private(set) var error: String?
  @Published private(set) var updatedAt: Date?
  @Published private(set) var projects: [String: Project] = [:]
  @Published private(set) var watching = false

  private let cli: Task<StimCLI, Never>
  private var started = false
  private var terminating = false
  private var watcher: Process?
  private var watchStderr: [String] = []
  private var backoff = RestartBackoff()
  private var pollTimer: Timer?
  private var inFlight = false
  private var issued = 0
  private var shown = 0

  init(cli: Task<StimCLI, Never>) {
    self.cli = cli
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
    guard !inFlight else { return }
    inFlight = true
    let sequence = nextSequence()
    let cli = cli
    Task.detached {
      let cli = await cli.value
      let result = Result { try cli.status() }
      await MainActor.run {
        self.inFlight = false
        self.show(result, sequence: sequence)
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
    let missing = payload.environments.map(\.path).filter { known[$0] == nil }
    Task.detached {
      let resolved = Dictionary(missing.map { ($0, Project.resolve(workspace: $0)) }, uniquingKeysWith: { first, _ in first })
      await MainActor.run {
        self.projects.merge(resolved) { old, _ in old }
        guard sequence > self.shown else { return }
        self.shown = sequence
        self.payload = payload
        self.error = nil
        self.updatedAt = Date()
      }
    }
  }

  func project(of env: Workspace) -> Project {
    projects[env.path] ?? Project(fallbackFor: env.path)
  }

  func environments(in project: Project?) -> [Workspace] {
    let all = payload?.environments ?? []
    guard let project else { return all }
    return all.filter { self.project(of: $0) == project }
  }

  /// Projects sorted with the ones that have live workspaces first.
  var projectList: [(project: Project, live: Int, total: Int)] {
    let envs = payload?.environments ?? []
    let grouped = Dictionary(grouping: envs) { project(of: $0) }
    return grouped
      .map { (project: $0.key, live: $0.value.filter(\.live).count, total: $0.value.count) }
      .sorted { ($0.live > 0 ? 0 : 1, $0.project.name.lowercased()) < ($1.live > 0 ? 0 : 1, $1.project.name.lowercased()) }
  }

  var warningCount: Int {
    (payload?.environments ?? []).reduce(0) { $0 + $1.warnings.count }
  }
}
