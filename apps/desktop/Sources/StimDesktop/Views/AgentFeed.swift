import StimKit
import SwiftUI

@MainActor
final class AgentFeedModel: ObservableObject {
  static let kept = 200

  /// Newest first.
  @Published private(set) var actions: [AgentAction] = []
  private var deviceID = ""
  private lazy var follower = LogFollower { [weak self] event in self?.handle(event) }

  func start(cli: StimCLI, workspace: String, slot: String, deviceID: String) {
    self.deviceID = deviceID
    actions = []
    var query = LogQuery()
    query.sources = [.agent]
    query.slot = slot
    query.tail = Self.kept
    follower.start(query, cli: cli, cwd: workspace)
  }

  func stop() {
    follower.stop()
    actions = []
  }

  private func handle(_ event: LogFollower.Event) {
    guard case .records(let batch) = event else { return }
    let next = AgentAction.appending(batch, to: actions, deviceID: deviceID, max: Self.kept)
    if next.first?.key != actions.first?.key { actions = next }
  }
}

struct AgentFeed<Content: View>: View {
  var cli: Task<StimCLI, Never>
  var workspace: String
  var device: DeviceRef
  @ViewBuilder var content: ([AgentAction]) -> Content
  @StateObject private var model = AgentFeedModel()

  private struct RunKey: Hashable {
    var workspace: String
    var slot: String
    var deviceID: String
  }

  var body: some View {
    content(model.actions)
      .task(id: device.activityKey.map { RunKey(workspace: workspace, slot: device.slot, deviceID: $0) }) {
        guard let deviceID = device.activityKey else { return }
        let cli = await cli.value
        guard !Task.isCancelled else { return }
        model.start(cli: cli, workspace: workspace, slot: device.slot, deviceID: deviceID)
        while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
        model.stop()
      }
  }
}
