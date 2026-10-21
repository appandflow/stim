import Foundation
import StimKit

/// The machine-wide record of what `stim gc`, automatic maintenance and the budget gate cleared, read through
/// `stim logs --source gc --json`.
@MainActor
final class GcHistoryModel: ObservableObject {
  @Published private(set) var runs: [GcRun] = []
  @Published private(set) var error: String?
  @Published private(set) var loaded = false

  private let cli: Task<StimCLI, Never>

  init(cli: Task<StimCLI, Never>) {
    self.cli = cli
  }

  func refresh() async {
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
