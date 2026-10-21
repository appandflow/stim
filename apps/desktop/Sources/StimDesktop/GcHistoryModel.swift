import Foundation
import StimKit

@MainActor
final class GcHistoryModel: ObservableObject {
  @Published private(set) var runs: [GcRun] = []
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
    let result = await Result.awaiting { try await cli.gcHistory() }
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
