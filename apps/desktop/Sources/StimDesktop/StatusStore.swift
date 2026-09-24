import Foundation
import StimKit

@MainActor
final class StatusStore: ObservableObject {
  @Published private(set) var payload: StatusPayload?
  @Published private(set) var error: String?
  @Published private(set) var updatedAt: Date?
  @Published private(set) var projects: [String: Project] = [:]

  private let cli: Task<StimCLI, Never>
  private var timer: Timer?
  private var inFlight = false

  init(cli: Task<StimCLI, Never>) {
    self.cli = cli
  }

  func start() {
    guard timer == nil else { return }
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refresh() }
    }
  }

  func refresh() {
    guard !inFlight else { return }
    inFlight = true
    let known = projects
    let cli = cli
    Task.detached {
      let cli = await cli.value
      let result = Result { try cli.status() }
      let resolved: [String: Project] =
        if case .success(let payload) = result {
          Dictionary(
            payload.environments.filter { known[$0.path] == nil }.map { ($0.path, Project.resolve(workspace: $0.path)) },
            uniquingKeysWith: { first, _ in first })
        } else {
          [:]
        }
      await MainActor.run {
        self.inFlight = false
        self.projects.merge(resolved) { old, _ in old }
        switch result {
        case .success(let payload):
          self.payload = payload
          self.error = nil
          self.updatedAt = Date()
        case .failure(let failure):
          self.error = failure.localizedDescription
        }
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
