import Foundation
import StimKit

@MainActor
final class BuildLedgerModel: ObservableObject {
  @Published private(set) var items: [LedgerBuild] = []
  @Published private(set) var error: String?
  @Published private(set) var loaded = false

  private let cli: Task<StimCLI, Never>

  init(cli: Task<StimCLI, Never>) {
    self.cli = cli
  }

  func poll() async {
    while !Task.isCancelled {
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
