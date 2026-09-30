import AppKit
import StimKit
import SwiftUI

struct LogTable: NSViewRepresentable {
  @ObservedObject var model: LogsModel
  @Binding var selection: IndexSet

  func makeCoordinator() -> Coordinator { Coordinator(model: model, selection: $selection) }

  func makeNSView(context: Context) -> NSScrollView {
    let table = CopyingTableView()
    table.addTableColumn(NSTableColumn(identifier: .init("record")))
    table.headerView = nil
    table.rowHeight = LogRowView.height(lines: 1)
    table.intercellSpacing = .zero
    table.allowsMultipleSelection = true
    table.usesAlternatingRowBackgroundColors = false
    table.backgroundColor = NSColor(Palette.background)
    table.style = .plain
    table.selectionHighlightStyle = .regular
    table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
    table.dataSource = context.coordinator
    table.delegate = context.coordinator
    table.copyText = { [weak coordinator = context.coordinator] in coordinator?.selectedText() }

    let scroll = NSScrollView()
    scroll.documentView = table
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = true
    scroll.backgroundColor = NSColor(Palette.background)
    scroll.contentView.postsBoundsChangedNotifications = true
    context.coordinator.attach(table: table, scroll: scroll)
    return scroll
  }

  func updateNSView(_ scroll: NSScrollView, context: Context) {}

  static func dismantleNSView(_ scroll: NSScrollView, coordinator: Coordinator) {
    coordinator.detach()
  }

  @MainActor
  final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    private let model: LogsModel
    private let selection: Binding<IndexSet>
    private weak var table: NSTableView?
    private var boundsObserver: NSObjectProtocol?
    private var scrollingProgrammatically = false

    init(model: LogsModel, selection: Binding<IndexSet>) {
      self.model = model
      self.selection = selection
    }

    func attach(table: NSTableView, scroll: NSScrollView) {
      self.table = table
      model.onChange = { [weak self] change in self?.apply(change) }
      boundsObserver = NotificationCenter.default.addObserver(
        forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated { self?.userScrolled() }
      }
      table.reloadData()
      scrollToLatest()
    }

    func detach() {
      model.onChange = nil
      if let boundsObserver { NotificationCenter.default.removeObserver(boundsObserver) }
    }

    private func apply(_ change: LogsModel.Change) {
      guard let table else { return }
      switch change {
      case .reset:
        table.reloadData()
        selection.wrappedValue = []
      case .updated(let from, let replaced):
        let count = model.rows.count
        let selected = table.selectedRowIndexes
        let kept = selected.filter { $0 < from }
        let moved = selected.filter { $0 >= from && $0 - from < replaced.count }.compactMap { row in
          (from..<count).first { model.rows[$0].lead == replaced[row - from] }
        }
        table.beginUpdates()
        table.removeRows(at: IndexSet(from..<(from + replaced.count)), withAnimation: [])
        table.insertRows(at: IndexSet(from..<count), withAnimation: [])
        table.endUpdates()
        let reselected = IndexSet(kept).union(IndexSet(moved))
        if reselected != table.selectedRowIndexes { table.selectRowIndexes(reselected, byExtendingSelection: false) }
        if model.pinnedToLatest { scrollToLatest() }
      case .trimmed(let removed, let lines):
        let origin = table.enclosingScrollView?.contentView.bounds.origin ?? .zero
        let kept = table.selectedRowIndexes.compactMap { $0 >= removed ? $0 - removed : nil }
        table.reloadData()
        table.selectRowIndexes(IndexSet(kept), byExtendingSelection: false)
        if model.pinnedToLatest {
          scrollToLatest()
        } else {
          let height = CGFloat(removed) * LogRowView.height(lines: 1) + CGFloat(lines - removed) * LogRowView.lineHeight
          scrollProgrammatically(to: NSPoint(x: origin.x, y: max(0, origin.y - height)))
        }
      case .jumpToLatest:
        scrollToLatest()
      case .reveal(let row):
        guard row < table.numberOfRows else { return }
        table.selectRowIndexes([row], byExtendingSelection: false)
        DispatchQueue.main.async { [weak self] in self?.center(row) }
      }
    }

    private func center(_ row: Int) {
      guard let table, row < table.numberOfRows, let clip = table.enclosingScrollView?.contentView else { return }
      let y = table.rect(ofRow: row).midY - clip.bounds.height / 2
      scrollProgrammatically(to: NSPoint(x: 0, y: max(0, min(y, table.frame.height - clip.bounds.height))))
    }

    private func scrollToLatest() {
      guard let table, let clip = table.enclosingScrollView?.contentView else { return }
      let y = max(0, table.frame.height - clip.bounds.height)
      scrollProgrammatically(to: NSPoint(x: 0, y: y))
    }

    private func scrollProgrammatically(to point: NSPoint) {
      guard let scroll = table?.enclosingScrollView else { return }
      scrollingProgrammatically = true
      scroll.contentView.scroll(to: point)
      scroll.reflectScrolledClipView(scroll.contentView)
      scrollingProgrammatically = false
    }

    private func userScrolled() {
      guard !scrollingProgrammatically, let table, let clip = table.enclosingScrollView?.contentView else { return }
      let atBottom = clip.bounds.maxY >= table.frame.height - LogRowView.height(lines: 1)
      if model.pinnedToLatest != atBottom { model.pinnedToLatest = atBottom }
    }

    func selectedText() -> String? {
      guard let table else { return nil }
      let rows = table.selectedRowIndexes.filter { $0 < model.rows.count }
      guard !rows.isEmpty else { return nil }
      return rows.map { model.rows[$0].entry.plainText }.joined(separator: "\n")
    }

    func numberOfRows(in tableView: NSTableView) -> Int { model.rows.count }

    func tableView(_ tableView: NSTableView, heightOfRow row: Int) -> CGFloat {
      LogRowView.height(lines: row < model.rows.count ? model.rows[row].lines : 1)
    }

    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
      LogSelectionRowView()
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
      let id = NSUserInterfaceItemIdentifier("logRow")
      let view = tableView.makeView(withIdentifier: id, owner: nil) as? LogRowView ?? LogRowView()
      view.identifier = id
      view.lines = row < model.rows.count ? LogRowText.lines(model.rows[row]) : []
      view.indent = row < model.rows.count ? LogRowText.messageColumn(model.rows[row].entry.lead) : 0
      return view
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
      guard let table else { return }
      selection.wrappedValue = table.selectedRowIndexes
    }
  }
}

final class LogSelectionRowView: NSTableRowView {
  override var isEmphasized: Bool {
    get { false }
    set {}
  }

  override func drawSelection(in dirtyRect: NSRect) {
    NSColor(Palette.selection).setFill()
    bounds.fill()
  }
}

final class CopyingTableView: NSTableView {
  var copyText: (() -> String?)?

  @objc func copy(_ sender: Any?) {
    guard let text = copyText?() else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }
}

final class LogRowView: NSView {
  static let lineHeight: CGFloat = 15
  static let inset: CGFloat = 2

  static func height(lines: Int) -> CGFloat { CGFloat(lines) * lineHeight + 2 * inset }

  var lines: [NSAttributedString] = [] {
    didSet { needsDisplay = true }
  }
  var indent: CGFloat = 0

  override var isFlipped: Bool { true }

  override func draw(_ dirtyRect: NSRect) {
    for (i, line) in lines.enumerated() {
      let x = i == 0 ? Self.inset : indent
      let rect = NSRect(
        x: x, y: Self.inset + CGFloat(i) * Self.lineHeight, width: max(0, bounds.width - x - Self.inset),
        height: Self.lineHeight)
      line.draw(with: rect, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    }
  }
}

enum LogRowText {
  static let font =
    NSFont(name: "JetBrainsMono-Regular", size: 11.5)
    ?? .monospacedSystemFont(ofSize: 11.5, weight: .regular)

  private static let characterWidth = NSAttributedString(string: "0", attributes: [.font: font]).size().width

  static func messageColumn(_ record: LogRecord) -> CGFloat {
    LogRowView.inset + CGFloat(27 + (record.slot.map { $0.count + 3 } ?? 0)) * characterWidth
  }

  private static let paragraph: NSParagraphStyle = {
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byTruncatingTail
    return style
  }()

  static func color(_ level: LogLevel) -> Color {
    switch level {
    case .debug: return Palette.tertiary
    case .info: return Palette.secondary
    case .warn: return Palette.warning
    case .error, .fatal: return Palette.error
    }
  }

  static func sourceLabel(_ src: String) -> String {
    switch LogSource(rawValue: src) {
    case .metro: return "metro"
    case .client: return "app"
    case .device: return "native"
    case .build: return "build"
    case .agent: return "agent"
    case nil: return src
    }
  }

  /// JetBrains Mono ships only its regular weight here, so bold is drawn as a stroke around each glyph.
  static func attributes(_ color: Color, bold: Bool = false) -> [NSAttributedString.Key: Any] {
    var attributes: [NSAttributedString.Key: Any] = [
      .font: font, .foregroundColor: NSColor(color), .paragraphStyle: paragraph,
    ]
    if bold { attributes[.strokeWidth] = -6.0 }
    return attributes
  }

  static func lines(_ row: LogsModel.Row) -> [NSAttributedString] {
    let record = row.entry.lead
    let head = NSMutableAttributedString()
    func add(_ string: String, _ color: Color) {
      head.append(NSAttributedString(string: string, attributes: attributes(color)))
    }
    add(record.date.formatted(LogRecord.timeFormat) + "  ", Palette.tertiary)
    add(record.level.rawValue.uppercased().padding(toLength: 6, withPad: " ", startingAt: 0), color(record.level))
    add(sourceLabel(record.src).padding(toLength: 7, withPad: " ", startingAt: 0), Palette.primary)
    if let slot = record.slot { add("[\(slot)] ", Palette.accent) }
    add(row.view.title.replacingOccurrences(of: "\t", with: "  "), record.level >= .error ? Palette.error : Palette.text)
    if !row.entry.related.isEmpty { add("  \(row.entry.related.count + 1) records", Palette.tertiary) }
    let extra = row.view.codeFrame.count + row.view.notes.count - row.entry.related.count
    if extra > 0 { add("  +" + countLabel(extra, "line"), Palette.tertiary) }

    var lines: [NSAttributedString] = [head]
    if let location = row.view.location {
      lines.append(NSAttributedString(string: location, attributes: attributes(Palette.text, bold: true)))
    }
    if let preview = row.preview {
      for frame in preview.frames {
        let text = [frame.fn, frame.location].filter { !$0.isEmpty }.joined(separator: "  ")
        lines.append(
          NSAttributedString(
            string: text, attributes: attributes(frame.app ? Palette.text : Palette.tertiary, bold: frame.app)))
      }
      if preview.hidden > 0 {
        let what = preview.hiddenFramework ? "framework frame" : "more frame"
        lines.append(NSAttributedString(string: "+" + countLabel(preview.hidden, what), attributes: attributes(Palette.tertiary)))
      }
    }
    return lines
  }
}
