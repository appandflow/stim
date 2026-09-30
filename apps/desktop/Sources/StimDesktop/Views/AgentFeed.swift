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

/// The compact preview of the agent row's popover: the newest actions and a way to the full log.
struct AgentActionsList: View {
  static let shown = 20

  var actions: [AgentAction]
  var driver: String?
  var showAll: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      HStack {
        Text(driver.map { "Driven by \($0)" } ?? "Agent actions").font(.stim(.headline))
        Spacer(minLength: Space.md)
        Button("All actions", action: showAll)
          .buttonStyle(.stim())
          .help("Show every agent action on this device, with filters")
      }
      if actions.isEmpty {
        Text("No agent action recorded on this device yet.").foregroundStyle(Palette.tertiary)
      }
      ForEach(actions.prefix(Self.shown), id: \.key) { action in
        HStack(alignment: .firstTextBaseline, spacing: Space.md) {
          Text(action.record.date.formatted(date: .omitted, time: .standard)).foregroundStyle(Palette.tertiary)
          Text(action.record.msg)
            .foregroundStyle(action.failed ? Palette.error : Palette.text)
            .lineLimit(2)
            .textSelection(.enabled)
        }
        .font(.stim(.caption, mono: true))
      }
    }
    .font(.stim(.callout))
  }
}

/// Every agent action kept for one device, newest first, as the phone's agent action screen shows them: filter
/// chips with counts, clock times and failed actions in the error tone. Clicking an action hands it to `select`.
struct AgentActionLog: View {
  var device: DeviceRef
  var actions: [AgentAction]
  var select: (AgentAction) -> Void
  var openLogs: () -> Void
  var close: () -> Void
  @State private var filter = AgentFilter.all

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
        .padding(Space.lg)
      if !actions.isEmpty {
        chips
          .padding(.horizontal, Space.lg)
          .padding(.bottom, Space.md)
      }
      Rectangle().fill(Palette.border).frame(height: 1)
      list
      Rectangle().fill(Palette.border).frame(height: 1)
      HStack {
        Spacer()
        Button("Open in logs", action: openLogs)
          .buttonStyle(.stim())
          .help("Show this device's agent actions in the logs")
      }
      .padding(.horizontal, Space.lg)
      .padding(.vertical, Space.md)
    }
    .background(Palette.surface)
  }

  private var header: some View {
    TimelineView(.periodic(from: .now, by: 5)) { context in
      let badge = ActivityBadge(device.activity, now: context.date)
      let driving: (tool: String, since: TimeInterval?)? =
        if case .driven(let tool, let since) = badge { (tool, since) } else { nil }
      HStack(alignment: .top, spacing: Space.md) {
        VStack(alignment: .leading, spacing: Space.xxs) {
          Text("\(device.label) \u{00B7} \(driving?.tool ?? "No agent")")
            .font(.stim(.headline))
            .lineLimit(1)
          Text(
            [driving?.since.map { "driving \(Format.duration($0))" }, countLabel(actions.count, "action")]
              .compactMap { $0 }.joined(separator: " \u{00B7} ")
          )
          .font(.stim(.footnote))
          .foregroundStyle(Palette.secondary)
        }
        Spacer(minLength: Space.sm)
        if driving != nil {
          Pill(tone: .success) { Text("active") }
        }
        Button("Close", systemImage: "xmark", action: close)
          .labelStyle(.iconOnly)
          .buttonStyle(.stim(.plain))
          .help("Hide the agent actions")
      }
    }
  }

  private var chips: some View {
    FlowLayout(spacing: Space.sm) {
      ForEach(AgentFilter.options(actions), id: \.filter) { option in
        let selected = option.filter == filter
        Button {
          filter = option.filter
        } label: {
          Pill(tone: selected ? .brand : option.filter == .failed ? .error : .neutral, outlined: !selected) {
            Text("\(option.label) \u{00B7} \(option.count)")
              .foregroundStyle(
                selected ? Palette.primary : option.filter == .failed ? Palette.error : Palette.text)
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
    }
  }

  @ViewBuilder private var list: some View {
    let shown = actions.filter(filter.matches)
    if shown.isEmpty {
      Text(actions.isEmpty ? "No agent action on this device yet." : "No action matches this filter.")
        .font(.stim(.footnote))
        .foregroundStyle(Palette.secondary)
        .padding(Space.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(shown.enumerated()), id: \.element.key) { index, action in
            if index > 0 { Rectangle().fill(Palette.separator).frame(height: 1) }
            AgentActionRow(action: action) { select(action) }
          }
        }
      }
    }
  }
}

private struct AgentActionRow: View {
  var action: AgentAction
  var select: () -> Void
  @State private var hovering = false

  var body: some View {
    let time = action.record.date.formatted(date: .omitted, time: .standard)
    Button(action: select) {
      HStack(alignment: .firstTextBaseline, spacing: Space.md) {
        Text(time)
          .font(.stim(.caption))
          .monospacedDigit()
          .foregroundStyle(Palette.tertiary)
          .frame(width: 76, alignment: .leading)
        if let command = action.record.command {
          Text(command)
            .font(.stim(.callout, weight: .semibold))
            .foregroundStyle(action.failed ? Palette.error : Palette.primary)
        }
        Text(action.record.msg)
          .font(.stim(.callout))
          .foregroundStyle(action.failed ? Palette.error : Palette.text)
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, Space.lg)
      .padding(.vertical, Space.md)
      .background(hovering ? Palette.raised : .clear)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .help(action.record.msg)
    .accessibilityLabel("\(time), \(action.record.msg)")
    .accessibilityHint("Shows this moment in the logs and the replay")
  }
}
