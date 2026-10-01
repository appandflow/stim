import AppKit
import StimKit
import SwiftUI

struct LogsView: View {
  var cli: Task<StimCLI, Never>
  var env: Workspace
  @Binding var query: LogQuery
  /// A moment to scroll to and select, taken and cleared once the logs follow `query`.
  @Binding var moment: LogMoment?
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
      Rectangle().fill(Palette.border).frame(height: 1)
      ZStack(alignment: .bottomTrailing) {
        LogTable(model: model, selection: $selection)
        overlay
      }
      if let row = selectedRow {
        Rectangle().fill(Palette.border).frame(height: 1)
        EntryDetail(row: row)
          .frame(height: 170)
      }
      Rectangle().fill(Palette.border).frame(height: 1)
      footer
    }
    .background(Palette.background)
    .onAppear { search = query.search }
    .onChange(of: query.search) { _, text in search = text }
    .onChange(of: moment?.id, initial: true) {
      guard let moment else { return }
      model.reveal(at: moment.at, in: effectiveQuery)
      self.moment = nil
    }
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

  private var selectedRow: LogsModel.Row? {
    guard selection.count == 1, let row = selection.first, row < model.rows.count else { return nil }
    return model.rows[row]
  }

  private var filterBar: some View {
    FlowLayout(spacing: Space.md) {
      ForEach(LogSource.allCases, id: \.self) { source in
        let on = query.sources.contains(source)
        Button {
          if on {
            if query.sources.count > 1 { query.sources.remove(source) }
          } else {
            query.sources.insert(source)
          }
        } label: {
          ToggleChip(on: on, tone: .brand) { Text(Self.title(source)) }
        }
        .buttonStyle(.hoverRow())
        .accessibilityAddTraits(on ? .isSelected : [])
        .help(Self.help(source))
      }
      Rectangle().fill(Palette.border).frame(width: 1, height: 18)
      if !slots.isEmpty {
        MenuPill(
          label: "Slot",
          selection: Binding(get: { effectiveQuery.slot }, set: { query.slot = $0 }),
          options: [MenuPillOption(value: String?.none, title: "All slots")]
            + slots.map { MenuPillOption(value: Optional($0), title: $0) },
          isActive: effectiveQuery.slot != nil
        )
      }
      MenuPill(
        label: "Level",
        selection: $query.minimumLevel,
        options: LogLevel.allCases.map {
          MenuPillOption(value: $0, title: $0 == .debug ? "All levels" : "\($0.rawValue.capitalized)+")
        },
        isActive: query.minimumLevel != .debug
      )
      Button {
        query.errorsOnly.toggle()
      } label: {
        ToggleChip(on: query.errorsOnly, tone: .error) {
          Image(systemName: "xmark.octagon")
          Text("Errors only")
        }
      }
      .buttonStyle(.hoverRow())
      .accessibilityAddTraits(query.errorsOnly ? .isSelected : [])
      .help("stim logs --errors: errors and fatals since the last marker")
      TextField("Search (regular expression)", text: $search)
        .textFieldStyle(.roundedBorder)
        .font(.stim(.footnote, mono: true))
        .frame(width: 220)
        .onSubmit { query.search = search }
    }
    .controlSize(.small)
    .padding(.horizontal, Space.lg)
    .padding(.vertical, Space.md)
  }

  @ViewBuilder private var overlay: some View {
    if case .ended(let message) = model.phase, model.count == 0 {
      EmptyState(title: "No logs", message: message)
    } else if model.count == 0 {
      Text(model.phase == .following ? "No matching records yet" : "")
        .foregroundStyle(Palette.tertiary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .allowsHitTesting(false)
    } else if !model.pinnedToLatest {
      Button {
        model.jumpToLatest()
      } label: {
        Label("Jump to latest", systemImage: "arrow.down.to.line")
      }
      .buttonStyle(.stim(.primary, .regular))
      .padding(Space.xl)
    }
  }

  private var footer: some View {
    HStack(spacing: Space.md) {
      switch model.phase {
      case .following:
        StatusDot(color: model.pinnedToLatest ? Palette.success : Palette.warning)
        Text(model.pinnedToLatest ? "Following" : "Paused")
      case .ended(let message):
        StatusDot(color: Palette.error)
        Text(abbreviatingHome(message)).lineLimit(1).truncationMode(.middle).help(abbreviatingHome(message))
      case .idle:
        EmptyView()
      }
      Text(
        countLabel(model.count, "record")
          + (model.count >= LogsModel.limit * 9 / 10 ? " (oldest dropped past \(LogsModel.limit.formatted()))" : "")
      )
      .foregroundStyle(Palette.tertiary)
      Spacer()
      Button("Copy") { copy() }
        .help(selection.isEmpty ? "Copy every loaded record" : "Copy the selected records")
      Button("Reveal log folder") {
        if let dir = env.logs?.dir { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: dir) }
      }
      .disabled(env.logs?.dir == nil)
    }
    .font(.stim(.footnote))
    .foregroundStyle(Palette.secondary)
    .controlSize(.small)
    .padding(.horizontal, Space.lg)
    .padding(.vertical, Space.md)
  }

  private func copy() {
    let rows = selection.isEmpty ? IndexSet(model.rows.indices) : selection
    let text = rows.filter { $0 < model.rows.count }.map { model.rows[$0].entry.plainText }.joined(separator: "\n")
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
    case .agent:
      return "agent: what agent-device did on this workspace's simulators and emulators, and agent input on its Chrome page"
    }
  }
}

struct LogMoment: Equatable {
  let id = UUID()
  /// Epoch milliseconds.
  var at: Double
}

private struct ToggleChip<Content: View>: View {
  var on: Bool
  var tone: Tone
  @ViewBuilder var content: Content

  var body: some View {
    Pill(tone: tone, outlined: !on) { content }
      .contentShape(Rectangle())
  }
}

private struct EntryDetail: NSViewRepresentable {
  var row: LogsModel.Row

  func makeNSView(context: Context) -> NSScrollView {
    let text = CodeFrameTextView(usingTextLayoutManager: false)
    text.isEditable = false
    text.isSelectable = true
    text.drawsBackground = false
    text.textContainerInset = NSSize(width: Space.md, height: Space.lg)
    text.isVerticallyResizable = true
    text.autoresizingMask = [.width]
    text.textContainer?.widthTracksTextView = true
    let scroll = NSScrollView()
    scroll.documentView = text
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = true
    scroll.backgroundColor = NSColor(Palette.sidebar)
    return scroll
  }

  struct Shown: Equatable {
    var ts: Double
    var src: String
    var related: Int
    var view: LogEntryView
  }

  final class Coordinator {
    var shown: Shown?
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func updateNSView(_ scroll: NSScrollView, context: Context) {
    let shown = Shown(ts: row.entry.lead.ts, src: row.entry.lead.src, related: row.entry.related.count, view: row.view)
    guard shown != context.coordinator.shown, let text = scroll.documentView as? CodeFrameTextView else { return }
    context.coordinator.shown = shown
    let (string, codeFrame) = Self.text(row)
    text.textStorage?.setAttributedString(string)
    text.codeFrame = codeFrame
    text.needsDisplay = true
    text.scroll(.zero)
  }

  static func text(_ row: LogsModel.Row) -> (NSAttributedString, NSRange?) {
    let record = row.entry.lead
    let out = NSMutableAttributedString()
    func add(_ string: String, _ color: Color, bold: Bool = false, paragraph: NSParagraphStyle? = nil) {
      var attributes = LogRowText.attributes(color, bold: bold)
      attributes[.paragraphStyle] = paragraph ?? Self.paragraph
      out.append(NSAttributedString(string: string, attributes: attributes))
    }
    var meta = [record.date.formatted(LogRecord.timeFormat)]
    meta += [record.slot, record.event, record.proc].compactMap { $0 }
    if !row.entry.related.isEmpty { meta.append("\(row.entry.related.count + 1) records") }
    add(record.level.rawValue.uppercased() + "  ", LogRowText.color(record.level))
    add(LogRowText.sourceLabel(record.src) + "  ", Palette.primary)
    add(meta.joined(separator: "  ") + "\n", Palette.tertiary)
    add(row.view.title + "\n", Palette.text)
    if let location = row.view.location { add(location + "\n", Palette.text, bold: true) }
    var codeFrame: NSRange?
    if !row.view.codeFrame.isEmpty {
      let before = (out.string as NSString).paragraphRange(for: NSRange(location: out.length - 1, length: 0))
      out.addAttribute(.paragraphStyle, value: Self.spaced(Self.paragraph), range: before)
      let start = out.length
      let lines = row.view.codeFrame
      if lines.count > 1 {
        add(lines.dropLast().joined(separator: "\n") + "\n", Palette.text, paragraph: Self.codeParagraph)
      }
      add(lines.last! + "\n", Palette.text, paragraph: Self.spaced(Self.codeParagraph))
      codeFrame = NSRange(location: start, length: out.length - start)
    }
    for note in row.view.notes { add(note + "\n", Palette.secondary) }
    for line in row.view.stack {
      add("  " + line.text + "\n", line.app ? Palette.text : Palette.tertiary, bold: line.app)
    }
    return (out, codeFrame)
  }

  private static let paragraph: NSParagraphStyle = {
    let style = NSMutableParagraphStyle()
    style.paragraphSpacing = 2
    return style
  }()

  private static func spaced(_ style: NSParagraphStyle) -> NSParagraphStyle {
    let spaced = style.mutableCopy() as! NSMutableParagraphStyle
    spaced.paragraphSpacing = Space.md + Space.xs
    return spaced
  }

  private static let codeParagraph: NSParagraphStyle = {
    let style = NSMutableParagraphStyle()
    style.firstLineHeadIndent = Space.md
    style.headIndent = Space.md
    style.lineBreakMode = .byClipping
    return style
  }()
}

private final class CodeFrameTextView: NSTextView {
  var codeFrame: NSRange?

  override func drawBackground(in rect: NSRect) {
    super.drawBackground(in: rect)
    guard let codeFrame, let layoutManager, let textContainer else { return }
    let glyphs = layoutManager.glyphRange(forCharacterRange: codeFrame, actualCharacterRange: nil)
    var box = layoutManager.boundingRect(forGlyphRange: glyphs, in: textContainer)
    box.origin.x = textContainerOrigin.x
    box.origin.y += textContainerOrigin.y
    box.size.width = textContainer.size.width
    box = box.insetBy(dx: 0, dy: -Space.xs)
    let path = NSBezierPath(roundedRect: box, xRadius: Radius.small, yRadius: Radius.small)
    NSColor(Palette.surface).setFill()
    path.fill()
    NSColor(Palette.border).setStroke()
    path.stroke()
  }
}
