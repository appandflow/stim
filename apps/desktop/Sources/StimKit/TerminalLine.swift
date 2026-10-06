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

  /// Indexes in `lines` that are new or differ in text or kind from the same index in `previous`.
  public static func indexesToType(previous: [TerminalLine], lines: [TerminalLine]) -> [Int] {
    lines.indices.filter { !previous.indices.contains($0) || previous[$0] != lines[$0] }
  }

  /// The last `maxVisibleLines` rows, preserving their indexes in `lines` and always retaining the last row.
  public static func visibleWindow(_ lines: [TerminalLine], maxVisibleLines: Int = 10) -> ArraySlice<TerminalLine> {
    lines.suffix(max(1, maxVisibleLines))
  }
}
