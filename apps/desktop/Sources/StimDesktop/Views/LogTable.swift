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
    table.rowHeight = Coordinator.rowHeight
    table.intercellSpacing = .zero
    table.allowsMultipleSelection = true
    table.usesAlternatingRowBackgroundColors = false
    table.backgroundColor = NSColor(Theme.background)
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
    scroll.backgroundColor = NSColor(Theme.background)
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
    static let rowHeight: CGFloat = 19

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
      case .appended:
        table.noteNumberOfRowsChanged()
        if model.pinnedToLatest { scrollToLatest() }
      case .trimmed(let removed):
        let origin = table.enclosingScrollView?.contentView.bounds.origin ?? .zero
        let kept = table.selectedRowIndexes.compactMap { $0 >= removed ? $0 - removed : nil }
        table.reloadData()
        table.selectRowIndexes(IndexSet(kept), byExtendingSelection: false)
        if model.pinnedToLatest {
          scrollToLatest()
        } else {
          scrollProgrammatically(to: NSPoint(x: origin.x, y: max(0, origin.y - CGFloat(removed) * Self.rowHeight)))
        }
      case .jumpToLatest:
        scrollToLatest()
      }
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
      let atBottom = clip.bounds.maxY >= table.frame.height - Self.rowHeight
      if model.pinnedToLatest != atBottom { model.pinnedToLatest = atBottom }
    }

    func selectedText() -> String? {
      guard let table else { return nil }
      let rows = table.selectedRowIndexes.filter { $0 < model.records.count }
      guard !rows.isEmpty else { return nil }
      return rows.map { model.records[$0].plainText }.joined(separator: "\n")
    }

    func numberOfRows(in tableView: NSTableView) -> Int { model.records.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
      let id = NSUserInterfaceItemIdentifier("logRow")
      let field: NSTextField
      if let reused = tableView.makeView(withIdentifier: id, owner: nil) as? NSTextField {
        field = reused
      } else {
        field = NSTextField(labelWithString: "")
        field.identifier = id
        field.lineBreakMode = .byTruncatingTail
        field.maximumNumberOfLines = 1
        field.cell?.truncatesLastVisibleLine = true
      }
      guard row < model.records.count else { return field }
      field.attributedStringValue = LogRowText.attributed(model.records[row])
      return field
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
      guard let table else { return }
      selection.wrappedValue = table.selectedRowIndexes
    }
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

enum LogRowText {
  static let font = NSFont(name: "JetBrainsMono-Regular", size: 11.5)
    ?? .monospacedSystemFont(ofSize: 11.5, weight: .regular)

  static func color(_ level: LogLevel) -> Color {
    switch level {
    case .debug: return Theme.tertiary
    case .info: return Theme.secondary
    case .warn: return Theme.warn
    case .error, .fatal: return Theme.error
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

  static func attributed(_ record: LogRecord) -> NSAttributedString {
    let text = NSMutableAttributedString()
    func add(_ string: String, _ color: Color) {
      text.append(NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: NSColor(color)]))
    }
    add(record.date.formatted(LogRecord.timeFormat) + "  ", Theme.tertiary)
    add(record.level.rawValue.uppercased().padding(toLength: 6, withPad: " ", startingAt: 0), color(record.level))
    add(sourceLabel(record.src).padding(toLength: 7, withPad: " ", startingAt: 0), Theme.primary)
    if let slot = record.slot { add("[\(slot)] ", Theme.lavender) }
    let lines = record.msg.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
    let first = lines.first.map(String.init) ?? ""
    add(abbreviatingHome(first).replacingOccurrences(of: "\t", with: "  "), record.level >= .error ? Theme.error : Theme.text)
    let extra = record.msg.reduce(0) { $1 == "\n" ? $0 + 1 : $0 } + (record.stack?.count ?? 0)
    if extra > 0 { add("  +" + countLabel(extra, "line"), Theme.tertiary) }
    return text
  }
}
