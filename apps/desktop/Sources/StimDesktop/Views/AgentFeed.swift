import StimKit
import SwiftUI

@MainActor
final class AgentFeedModel: ObservableObject {
  static let shown = 6

  @Published private(set) var actions: [LogRecord] = []
  private var deviceID = ""
  private lazy var follower = LogFollower { [weak self] event in self?.handle(event) }

  func start(cli: StimCLI, workspace: String, slot: String, deviceID: String) {
    self.deviceID = deviceID
    actions = []
    var query = LogQuery()
    query.sources = [.agent]
    query.slot = slot
    query.tail = 200
    follower.start(query, cli: cli, cwd: workspace)
  }

  func stop() {
    follower.stop()
    actions = []
  }

  private func handle(_ event: LogFollower.Event) {
    guard case .records(let batch) = event else { return }
    let mine = batch.filter { $0.deviceId == deviceID }
    guard !mine.isEmpty else { return }
    actions = Array((actions + mine).suffix(Self.shown))
  }
}

struct AgentFeed: View {
  var cli: Task<StimCLI, Never>
  var workspace: String
  var device: DeviceRef
  @StateObject private var model = AgentFeedModel()

  private struct RunKey: Hashable {
    var workspace: String
    var slot: String
    var deviceID: String
  }

  var body: some View {
    Group {
      if !model.actions.isEmpty {
        VStack(alignment: .leading, spacing: Space.xs) {
          Text("Agent actions")
            .font(.stim(.caption, weight: .semibold))
            .foregroundStyle(Palette.secondary)
          ForEach(Array(model.actions.enumerated().reversed()), id: \.offset) { _, record in
            HStack(spacing: Space.md) {
              Text(record.date.formatted(LogRecord.timeFormat)).foregroundStyle(Palette.tertiary)
              Text(record.msg)
                .foregroundStyle(record.level >= .error ? Palette.error : Palette.text)
                .lineLimit(1)
                .truncationMode(.tail)
            }
            .font(.stim(.caption, mono: true))
          }
        }
        .padding(Space.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.sidebar))
        .help("stim logs --source agent: what agent-device did on this device")
      }
    }
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
