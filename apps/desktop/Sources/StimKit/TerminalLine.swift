public struct TerminalLine: Equatable, Sendable {
  public enum Kind: Equatable, Sendable {
    case command, output, ok, failed, pending, skipped

    public var symbolName: String? {
      switch self {
      case .command, .output: nil
      case .ok: "checkmark"
      case .failed: "xmark"
      case .pending: "ellipsis"
      case .skipped: "minus"
      }
    }
  }

  public var text: String
  public var kind: Kind

  public init(text: String, kind: Kind) {
    self.text = text
    self.kind = kind
  }

  /// Indexes in `lines` that are new or differ in text from the same index in `previous`.
  public static func indexesToType(previous: [TerminalLine], lines: [TerminalLine]) -> [Int] {
    lines.indices.filter { !previous.indices.contains($0) || previous[$0].text != lines[$0].text }
  }

  /// A spoken description of the complete terminal, including each check's state.
  public static func spokenSummary(_ lines: [TerminalLine]) -> String {
    lines.map { line in
      let state: String
      switch line.kind {
      case .command: state = "command"
      case .output: state = "output"
      case .ok: state = "done"
      case .failed: state = "failed"
      case .pending: state = "in progress"
      case .skipped: state = "skipped"
      }
      return "\(state): \(line.text)"
    }.joined(separator: ". ")
  }

  /// The last `maxVisibleLines` rows, preserving their indexes in `lines` and always retaining the last row.
  public static func visibleWindow(_ lines: [TerminalLine], maxVisibleLines: Int = 10) -> ArraySlice<TerminalLine> {
    lines.suffix(max(1, maxVisibleLines))
  }
}
