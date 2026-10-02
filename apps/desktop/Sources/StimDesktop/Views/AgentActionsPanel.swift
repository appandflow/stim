import Combine
import StimKit
import SwiftUI

/// The device viewer's agent actions, oldest first beside the screen, as a session replay lists its events: filter
/// chips with counts, the action on screen highlighted and kept in view, and a click on an action shows its details,
/// until another action comes on screen, and, when the replay recorded it, plays from just before it. Up and down move
/// through the actions and space plays and pauses while the list has the keyboard.
struct AgentActionsPanel: View {
  /// Newest first, as `AgentFeedModel` keeps them.
  var actions: [AgentAction]
  var replay: ReplayController?
  /// Whether recorded actions can be replayed: stim-server records this workspace and can send this device's video.
  var canReplay: Bool
  var focused: FocusState<Bool>.Binding
  var seek: (AgentAction) -> Void
  var playOrPause: (() -> Void)?
  /// Shows the device's agent actions in the logs at the action given, closing the viewer.
  var openLogs: (AgentAction?) -> Void
  @State private var filter = AgentFilter.all
  @State private var selected: Int?
  @State private var shown = Shown()
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// What the list shows of the replay: the action on screen and the actions it recorded, kept apart from the range
  /// so a span growing while live redraws the list only when an action's recorded state changes.
  private struct Shown: Equatable {
    var live = true
    var current: Int?
    var recorded: Set<Int> = []
  }

  var body: some View {
    let list = AgentActionList(actions, filter: filter)
    VStack(alignment: .leading, spacing: 0) {
      header
        .padding(.horizontal, Space.lg)
        .padding(.top, Space.lg)
        .padding(.bottom, Space.md)
      Rectangle().fill(Palette.border).frame(height: 1)
      rows(list)
      Rectangle().fill(Palette.border).frame(height: 1)
      HStack {
        Text(shown.live ? "Following live" : "Replaying")
          .font(.stim(.caption))
          .foregroundStyle(Palette.tertiary)
        Spacer()
        Button("Open in logs") { openLogs(actions.first { $0.key == selected ?? shown.current }) }
          .buttonStyle(.stim())
          .help("Close the viewer and show this device's agent actions in the logs")
      }
      .padding(.horizontal, Space.lg)
      .padding(.vertical, Space.md)
    }
    .onReceive(publisher) { replayed, stepped, range in
      update(list, replayed: replayed, stepped: stepped, range: range)
    }
    .onChange(of: ListKey(newest: actions.first?.key, filter: filter)) {
      update(list, replayed: replay?.replay, stepped: replay?.stepped, range: replay?.range)
    }
  }

  private struct ListKey: Equatable {
    var newest: Int?
    var filter: AgentFilter
  }

  /// `@Published` sends the new value before the property changes, so the list reads the values it is sent.
  private var publisher: AnyPublisher<(ReplayController.Replay?, Double?, ReplayRange?), Never> {
    guard let replay else {
      return Just((nil, nil, nil)).eraseToAnyPublisher()
    }
    return replay.$replay.combineLatest(replay.$stepped, replay.$range)
      .map { ($0, $1, $2) }
      .eraseToAnyPublisher()
  }

  private func update(
    _ list: AgentActionList, replayed: ReplayController.Replay?, stepped: Double?, range: ReplayRange?
  ) {
    let timeline = canReplay ? range.flatMap { ReplayTimeline(spans: $0.spans) } : nil
    let next = Shown(
      live: replayed == nil,
      current: list.current(live: replayed == nil, at: replayed?.at, stepped: stepped),
      recorded: Set(actions.filter { timeline?.seekTime(forActionAt: $0.at) != nil }.map(\.key)))
    if next != shown { shown = next }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      HStack(alignment: .firstTextBaseline) {
        Text("Agent actions").font(.stim(.headline)).accessibilityAddTraits(.isHeader)
        Spacer()
        Text(countLabel(actions.count, "action")).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      }
      if !actions.isEmpty {
        FlowLayout(spacing: Space.sm) {
          ForEach(AgentFilter.options(actions), id: \.filter) { option in
            let on = option.filter == filter
            Button {
              filter = option.filter
            } label: {
              Pill(tone: on ? .brand : option.filter == .failed ? .error : .neutral, size: .small, outlined: !on) {
                Text("\(option.label) \u{00B7} \(option.count)")
                  .foregroundStyle(on ? Palette.primary : option.filter == .failed ? Palette.error : Palette.text)
              }
            }
            .buttonStyle(.hoverRow())
            .accessibilityLabel("\(option.label), \(option.count)")
            .accessibilityAddTraits(on ? .isSelected : [])
          }
        }
      }
    }
  }

  @ViewBuilder private func rows(_ list: AgentActionList) -> some View {
    if list.actions.isEmpty {
      Text(actions.isEmpty ? "No agent action on this device yet." : "No action matches this filter.")
        .font(.stim(.footnote))
        .foregroundStyle(Palette.secondary)
        .padding(Space.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    } else {
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(list.rows, id: \.id) { row in
              switch row {
              case .gap(let ms, _):
                gapRow(ms)
              case .action(let action):
                AgentActionRow(
                  action: action, current: action.key == shown.current, expanded: action.key == selected,
                  recorded: shown.recorded.contains(action.key)
                ) { select(action) }
                .id(action.key)
              }
            }
          }
          .padding(.vertical, Space.xs)
        }
        .onChange(of: shown.current) { _, key in
          if selected != key { selected = nil }
          guard let key else { return }
          if reduceMotion {
            proxy.scrollTo(key, anchor: .center)
          } else {
            withAnimation { proxy.scrollTo(key, anchor: .center) }
          }
        }
        .onAppear { if let current = shown.current { proxy.scrollTo(current, anchor: .center) } }
      }
      .focusable()
      .focused(focused)
      .focusEffectDisabled()
      .onKeyPress(.downArrow) { move(list, forward: true) }
      .onKeyPress(.upArrow) { move(list, forward: false) }
      .onKeyPress(.space) {
        guard let playOrPause else { return .ignored }
        playOrPause()
        return .handled
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Agent actions")
    }
  }

  private func move(_ list: AgentActionList, forward: Bool) -> KeyPress.Result {
    guard let action = list.adjacent(to: selected ?? shown.current, forward: forward) else { return .ignored }
    select(action)
    return .handled
  }

  /// Shows the action's details and, when the replay recorded it, plays from just before it. Selecting the action
  /// whose details show hides them.
  private func select(_ action: AgentAction) {
    guard selected != action.key else {
      selected = nil
      return
    }
    selected = action.key
    if shown.recorded.contains(action.key) { seek(action) }
  }

  private func gapRow(_ ms: Double) -> some View {
    HStack(spacing: Space.sm) {
      Rectangle().fill(Palette.separator).frame(height: 1)
      Text("\(Format.roundedDuration(ms: ms)) later")
        .font(.stim(.caption2))
        .foregroundStyle(Palette.tertiary)
        .fixedSize()
      Rectangle().fill(Palette.separator).frame(height: 1)
    }
    .padding(.horizontal, Space.lg)
    .padding(.vertical, Space.sm)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(Format.roundedDuration(ms: ms)) later")
  }
}

extension AgentActionList.Row {
  fileprivate var id: String {
    switch self {
    case .gap(_, let before): return "gap-\(before)"
    case .action(let action): return "action-\(action.key)"
    }
  }
}

/// One agent action: its clock time, command and message, and with `expanded` its level, device and whether the
/// replay recorded it. `current` marks the action on screen.
private struct AgentActionRow: View {
  var action: AgentAction
  var current: Bool
  var expanded: Bool
  var recorded: Bool
  var select: () -> Void

  var body: some View {
    let time = action.record.date.formatted(date: .omitted, time: .standard)
    Button(action: select) {
      VStack(alignment: .leading, spacing: Space.xs) {
        HStack(alignment: .firstTextBaseline, spacing: Space.md) {
          Text(time)
            .font(.stim(.caption))
            .monospacedDigit()
            .foregroundStyle(current ? Palette.primary : Palette.tertiary)
            .lineLimit(1)
            .fixedSize()
          if let command = action.record.command {
            Text(command)
              .font(.stim(.caption, mono: true))
              .foregroundStyle(action.failed ? Palette.error : Palette.primary)
              .lineLimit(1)
              .fixedSize()
          }
          Text(action.record.msg)
            .font(.stim(.callout, weight: current ? .semibold : .regular))
            .foregroundStyle(action.failed ? Palette.error : Palette.text)
            .lineLimit(expanded ? nil : 1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
          if recorded {
            Image(systemName: "play.circle")
              .font(.system(size: 11))
              .foregroundStyle(current ? Palette.primary : Palette.tertiary)
              .accessibilityHidden(true)
          }
        }
        if expanded {
          details
        }
      }
      .padding(.horizontal, Space.lg)
      .padding(.vertical, Space.sm)
      .overlay(alignment: .leading) {
        if current { Rectangle().fill(Palette.accent).frame(width: 3) }
      }
    }
    .buttonStyle(.hoverRow(radius: 0, selected: current || expanded))
    .help(recorded ? "Replay from just before this action" : "")
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      [time, action.record.command, action.failed ? "failed" : nil, action.record.msg].compactMap { $0 }.joined(separator: ", ")
    )
    .accessibilityValue(current ? "On screen" : "")
    .accessibilityAddTraits(expanded ? .isSelected : [])
    .accessibilityHint(recorded ? "Replays from just before this action" : "Shows its details. The replay did not record it.")
  }

  private var details: some View {
    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: Space.sm, verticalSpacing: Space.xxs) {
      detail("Level", action.record.level.rawValue)
      if let command = action.record.command { detail("Command", command) }
      if let device = action.record.deviceId { detail("Device", device) }
      detail("Replay", recorded ? "Recorded" : "Not recorded")
    }
    .font(.stim(.caption))
    .padding(.leading, Space.xs)
  }

  private func detail(_ key: String, _ value: String) -> some View {
    GridRow {
      Text(key).foregroundStyle(Palette.tertiary)
      Text(value).foregroundStyle(Palette.secondary).textSelection(.enabled)
    }
  }
}
