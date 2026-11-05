import Foundation
import StimKit

@MainActor
final class GcHistoryModel: ObservableObject {
  @Published private(set) var runs: [GcRun] = []
  @Published private(set) var error: String?
  @Published private(set) var loaded = false

  private let environment: Task<[String: String], Never>

  init(environment: Task<[String: String], Never>) {
    self.environment = environment
  }

  func poll() async {
    while !Task.isCancelled {
      await refresh()
      try? await Task.sleep(for: .seconds(30))
    }
  }

  private func refresh() async {
    let environment = await environment.value
    let result = await Result.awaiting {
      try await GcHistory.read(
        stimHome: StimHome.path(environment: environment), connection: ServerSession.shared.statsConnection)
    }
    guard !Task.isCancelled else { return }
    switch result {
    case .success(let items):
      runs = GcHistory.runs(items)
      error = nil
    case .failure(let failure):
      error = failure.localizedDescription
    }
    loaded = true
  }
}
