import Foundation
import StimKit

@MainActor
final class BuildLedgerModel: ObservableObject {
  @Published private(set) var items: [LedgerBuild] = []
  @Published private(set) var error: String?
  @Published private(set) var loaded = false

  private let environment: Task<[String: String], Never>

  private let polls: Bool

  init(environment: Task<[String: String], Never>) {
    self.environment = environment
    polls = true
  }

  #if DEBUG
    init(items: [LedgerBuild]) {
      environment = Task { [:] }
      polls = false
      self.items = items
      loaded = true
    }
  #endif

  func poll() async {
    while polls && !Task.isCancelled {
      await refresh()
      try? await Task.sleep(for: .seconds(30))
    }
  }

  private func refresh() async {
    let environment = await environment.value
    let result = await Result.awaiting {
      try await BuildLedger.read(
        stimHome: StimHome.path(environment: environment), connection: ServerSession.shared.statsConnection)
    }
    guard !Task.isCancelled else { return }
    switch result {
    case .success(let items):
      self.items = items
      error = nil
    case .failure(let failure):
      error = failure.localizedDescription
    }
    loaded = true
  }
}
