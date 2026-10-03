import Foundation
import XcbeautifyLib

/// A display projection of log entries; original records remain unchanged for copying and raw display.
public final class XcodeLogPresentation {
  public private(set) var messages: [String?] = []
  private var states: [[String: Int]] = [[:]]
  private var requestedLines = 0
  private lazy var beautifier = XCBeautifier(
    colored: false, renderer: .terminal, preserveUnbeautifiedLines: true,
    additionalLines: { [weak self] in
      self?.requestedLines += 1
      return nil
    })

  public init() {}

  /// Drops original entries while retaining the continuation state at the new beginning.
  public func dropFirst(_ count: Int) {
    messages.removeFirst(count)
    states.removeFirst(count)
  }

  /// Replaces the changed suffix, preserving diagnostic continuation across live batches and independent slots.
  public func update(_ entries: [LogEntry], from: Int) {
    messages.removeSubrange(from...)
    states.removeSubrange((from + 1)...)
    var remaining = states.last!
    for entry in entries[from...] {
      let record = entry.lead
      let slot = record.slot ?? ""
      var text: String? = record.msg
      if record.src == "build" && (record.event == "build_start" || record.event == "build_done") {
        remaining[slot] = nil
      }
      if record.src == "build", record.level == .debug, record.event == nil, record.raw != true {
        if let count = remaining[slot], count > 0 {
          remaining[slot] = count > 1 ? count - 1 : nil
        } else {
          requestedLines = 0
          text = beautifier.format(line: record.msg)?.trimmingCharacters(in: .newlines)
          if requestedLines > 0 { remaining[slot] = requestedLines }
        }
      }
      messages.append(text)
      states.append(remaining)
    }
  }
}
