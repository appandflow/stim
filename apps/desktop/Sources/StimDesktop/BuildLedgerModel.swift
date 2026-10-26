import Foundation
import StimKit

@MainActor
final class BuildLedgerModel: ObservableObject {
  @Published private(set) var items: [LedgerBuild] = []
  @Published private(set) var error: String?
  @Published private(set) var loaded = false

  private let cli: Task<StimCLI, Never>

  private let polls: Bool

  init(cli: Task<StimCLI, Never>) {
    self.cli = cli
    polls = true
  }

  #if DEBUG
    /// A model that shows `items` and never runs the CLI, for fixtures.
    init(items: [LedgerBuild]) {
      cli = Task { StimCLI(environment: [:]) }
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
    let cli = await cli.value
    let result = await Result.awaiting { try await cli.buildLedger() }
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
