import StimKit
import SwiftUI

@MainActor
final class AgentFeedModel: ObservableObject {
  static let kept = 200

  /// Newest first.
  @Published private(set) var actions: [AgentAction] = []
  private var deviceID = ""
  private var session = 0
  private lazy var follower = LogFollower { [weak self] event in self?.handle(event) }

  func start(cli: StimCLI, connection: (client: ServerClient, home: String)?, workspace: String, slot: String, deviceID: String)
    -> Int
  {
    session += 1
    self.deviceID = deviceID
    actions = []
    var query = LogQuery()
    query.sources = [.agent]
    query.slot = slot
    query.tail = Self.kept
    follower.start(query, cli: cli, connection: connection, cwd: workspace)
    return session
  }

  func stop(session: Int) {
    guard self.session == session else { return }
    follower.stop()
    actions = []
  }

  private func handle(_ event: LogFollower.Event) {
    if case .reset = event { actions = [] }
    guard case .records(let batch) = event else { return }
    let next = AgentAction.appending(batch, to: actions, deviceID: deviceID, max: Self.kept)
    if next.first?.key != actions.first?.key { actions = next }
  }
}

struct AgentFeed<Content: View>: View {
  var cli: Task<StimCLI, Never>
  var workspace: String
  var slot: String
  var deviceID: String?
  @ViewBuilder var content: ([AgentAction]) -> Content
  @StateObject private var model = AgentFeedModel()
  @ObservedObject private var server = ServerSession.shared

  private struct RunKey: Hashable {
    var workspace: String
    var slot: String
    var deviceID: String
    var connected: Bool
    var client: ObjectIdentifier?
    var home: String?
  }

  var body: some View {
    content(model.actions)
      .task(
        id: deviceID.map {
          RunKey(
            workspace: workspace, slot: slot, deviceID: $0, connected: server.isOpen,
            client: server.client.map(ObjectIdentifier.init), home: server.statsConnection?.home)
        }
      ) {
        guard let deviceID else { return }
        let cli = await cli.value
        guard !Task.isCancelled else { return }
        let session = model.start(
          cli: cli, connection: server.statsConnection, workspace: workspace, slot: slot, deviceID: deviceID)
        while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
        model.stop(session: session)
      }
  }
}
