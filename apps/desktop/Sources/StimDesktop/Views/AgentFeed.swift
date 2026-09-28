import StimKit
import SwiftUI

@MainActor
final class AgentFeedModel: ObservableObject {
  static let shown = 20

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

struct AgentFeed<Content: View>: View {
  var cli: Task<StimCLI, Never>
  var workspace: String
  var device: DeviceRef
  @ViewBuilder var content: ([LogRecord]) -> Content
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

struct AgentActionsList: View {
  var actions: [LogRecord]
  var driver: String?

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Text(driver.map { "Driven by \($0)" } ?? "Agent actions").font(.stim(.headline))
      if actions.isEmpty {
        Text("No agent action recorded on this device yet.").foregroundStyle(Palette.tertiary)
      }
      ForEach(Array(actions.enumerated().reversed()), id: \.offset) { _, record in
        HStack(alignment: .firstTextBaseline, spacing: Space.md) {
          Text(record.date.formatted(LogRecord.timeFormat)).foregroundStyle(Palette.tertiary)
          Text(record.msg)
            .foregroundStyle(record.level >= .error ? Palette.error : Palette.text)
            .lineLimit(2)
            .textSelection(.enabled)
        }
        .font(.stim(.caption, mono: true))
      }
    }
    .font(.stim(.callout))
  }
}
