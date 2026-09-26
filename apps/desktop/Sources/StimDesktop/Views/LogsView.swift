import AppKit
import StimKit
import SwiftUI

struct LogsView: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  @Binding var query: LogQuery
  @StateObject private var model = LogsModel()
  @State private var search = ""
  @State private var selection = IndexSet()

  private var slots: [String] {
    var seen = Set<String>()
    return env.devices.map(\.slot).filter { seen.insert($0).inserted }
  }

  private var effectiveQuery: LogQuery {
    var query = query
    if let slot = query.slot, !slots.contains(slot) { query.slot = nil }
    return query
  }

  private struct RunKey: Hashable {
    var path: String
    var query: LogQuery
  }

  var body: some View {
    VStack(spacing: 0) {
      filterBar
      Rectangle().fill(Theme.border).frame(height: 1)
      ZStack(alignment: .bottomTrailing) {
        LogTable(model: model, selection: $selection)
        overlay
      }
      if let record = selectedRecord {
        Rectangle().fill(Theme.border).frame(height: 1)
        RecordDetail(record: record)
          .frame(height: 170)
      }
      Rectangle().fill(Theme.border).frame(height: 1)
      footer
    }
    .background(Theme.background)
    .onAppear { search = query.search }
    .task(id: search) {
      guard search != query.search else { return }
      try? await Task.sleep(for: .milliseconds(350))
      if !Task.isCancelled { query.search = search }
    }
    .task(id: RunKey(path: env.path, query: effectiveQuery)) {
      let cli = await cli.value
      guard !Task.isCancelled else { return }
      let session = model.start(effectiveQuery, cli: cli, cwd: env.path)
      while !Task.isCancelled { try? await Task.sleep(for: .seconds(3600)) }
      model.stop(session: session)
    }
  }

  private var selectedRecord: LogRecord? {
    guard selection.count == 1, let row = selection.first, row < model.records.count else { return nil }
    return model.records[row]
  }

  private var filterBar: some View {
    FlowLayout(spacing: 8) {
      ForEach(LogSource.allCases, id: \.self) { source in
        let on = query.sources.contains(source)
        Button {
          if on {
            if query.sources.count > 1 { query.sources.remove(source) }
          } else {
            query.sources.insert(source)
          }
        } label: {
          ToggleChip(on: on, tint: Theme.lavender) { Text(Self.title(source)) }
        }
        .buttonStyle(.plain)
        .help(Self.help(source))
      }
      Rectangle().fill(Theme.border).frame(width: 1, height: 18)
      if !slots.isEmpty {
        Picker("Slot", selection: Binding(get: { effectiveQuery.slot }, set: { query.slot = $0 })) {
          Text("All slots").tag(String?.none)
          ForEach(slots, id: \.self) { slot in Text(slot).tag(Optional(slot)) }
        }
        .labelsHidden()
        .fixedSize()
      }
      Picker("Level", selection: $query.minimumLevel) {
        ForEach(LogLevel.allCases, id: \.self) { level in
          Text(level == .debug ? "All levels" : "\(level.rawValue.capitalized)+").tag(level)
        }
      }
      .labelsHidden()
      .fixedSize()
      Button {
        query.errorsOnly.toggle()
      } label: {
        ToggleChip(on: query.errorsOnly, tint: Theme.error) {
          Image(systemName: "xmark.octagon")
          Text("Errors only")
        }
      }
      .buttonStyle(.plain)
      .help("stim logs --errors: errors and fatals since the last marker")
      TextField("Search (regular expression)", text: $search)
        .textFieldStyle(.roundedBorder)
        .font(Theme.mono(11.5))
        .frame(width: 220)
        .onSubmit { query.search = search }
    }
    .controlSize(.small)
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
  }

  @ViewBuilder private var overlay: some View {
    if case .ended(let message) = model.phase, model.count == 0 {
      EmptyState(title: "No logs", message: message)
    } else if model.count == 0 {
      Text(model.phase == .following ? "No matching records yet" : "")
        .foregroundStyle(Theme.tertiary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
    } else if !model.pinnedToLatest {
      Button { model.jumpToLatest() } label: {
        Label("Jump to latest", systemImage: "arrow.down.to.line")
          .padding(.horizontal, 10)
          .padding(.vertical, 6)
          .background(Capsule().fill(Theme.purple))
          .foregroundStyle(Theme.text)
      }
      .buttonStyle(.plain)
      .padding(16)
    }
  }

  private var footer: some View {
    HStack(spacing: 10) {
      switch model.phase {
      case .following:
        StatusDot(color: model.pinnedToLatest ? Theme.live : Theme.warn)
        Text(model.pinnedToLatest ? "Following" : "Paused")
      case .ended(let message):
        StatusDot(color: Theme.error)
        Text(abbreviatingHome(message)).lineLimit(1).truncationMode(.middle).help(abbreviatingHome(message))
      case .idle:
        EmptyView()
      }
      Text(
        countLabel(model.count, "record")
          + (model.count >= LogsModel.limit * 9 / 10 ? " (oldest dropped past \(LogsModel.limit.formatted()))" : "")
      )
      .foregroundStyle(Theme.tertiary)
      Spacer()
      Button("Copy") { copy() }
        .help(selection.isEmpty ? "Copy every loaded record" : "Copy the selected records")
      Button("Reveal log folder") {
        if let dir = env.logs?.dir { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: dir) }
      }
      .disabled(env.logs?.dir == nil)
    }
    .font(Theme.body(11.5))
    .foregroundStyle(Theme.secondary)
    .controlSize(.small)
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
  }

  private func copy() {
    let rows = selection.isEmpty ? IndexSet(model.records.indices) : selection
    let text = rows.filter { $0 < model.records.count }.map { model.records[$0].plainText }.joined(separator: "\n")
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  static func title(_ source: LogSource) -> String {
    switch source {
    case .metro: return "Metro"
    case .client: return "App"
    case .device: return "Native"
    case .build: return "Build"
    case .agent: return "Agent"
    }
  }

  static func help(_ source: LogSource) -> String {
    switch source {
    case .metro: return "metro: the bundler, and everything Expo prints in expo-child mode"
    case .client: return "client: in-app console logs and redboxes (bare React Native)"
    case .device: return "device: simulator, emulator or device logs of the app process"
    case .build: return "build: native builds, installs and launches"
    case .agent: return "agent: what agent-device did on this workspace's simulators and emulators"
    }
  }
}

private struct ToggleChip<Content: View>: View {
  var on: Bool
  var tint: Color
  @ViewBuilder var content: Content

  var body: some View {
    HStack(spacing: 6) { content }
      .font(Theme.body(11.5))
      .foregroundStyle(on ? tint : Theme.tertiary)
      .padding(.horizontal, 9)
      .padding(.vertical, 4)
      .background(RoundedRectangle(cornerRadius: 7).fill(on ? tint.opacity(0.16) : .clear))
      .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(on ? .clear : Theme.border))
      .contentShape(Rectangle())
  }
}

private struct RecordDetail: View {
  var record: LogRecord

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 8) {
          Text(record.date.formatted(LogRecord.timeFormat)).foregroundStyle(Theme.tertiary)
          Text(record.level.rawValue.uppercased()).foregroundStyle(LogRowText.color(record.level))
          Text(LogRowText.sourceLabel(record.src)).foregroundStyle(Theme.primary)
          if let slot = record.slot { Text(slot).foregroundStyle(Theme.lavender) }
          if let event = record.event { Text(event).foregroundStyle(Theme.tertiary) }
          if let proc = record.proc { Text(proc).foregroundStyle(Theme.tertiary) }
        }
        Text(abbreviatingHome(record.msg)).foregroundStyle(Theme.text)
        ForEach(Array((record.stack ?? []).enumerated()), id: \.offset) { _, frame in
          Text("  at \(abbreviatingHome(frame.description))").foregroundStyle(Theme.secondary)
        }
      }
      .font(Theme.mono(11.5))
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
    }
    .background(Theme.sidebar)
  }
}
