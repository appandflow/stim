import Foundation

/// The scrubber's track: recorded spans laid end to end in proportion to their length, with each unrecorded gap
/// between them drawn at a fixed share. `from` and `to` are a piece's place on the track, 0 to 1. Every time is a
/// Mac capture time from `replay.range`; a device still recorded ends at its newest footage.
public struct ReplayTimeline: Equatable, Sendable {
  public struct Piece: Equatable, Sendable {
    public var isGap: Bool
    public var start: Double
    public var end: Double
    public var from: Double
    public var to: Double
  }

  static let gapShare = 0.08
  static let minimumGapWeightMs = 2000.0

  public var start: Double
  public var end: Double
  public var pieces: [Piece]

  public init?(spans: [ReplaySpan]) {
    guard let first = spans.first, let last = spans.last else { return nil }
    let recorded = spans.reduce(0) { $0 + max($1.end - $1.start, 1) }
    let gapWeight = max(recorded * Self.gapShare, Self.minimumGapWeightMs)
    let total = recorded + gapWeight * Double(spans.count - 1)
    var pieces: [Piece] = []
    var at = 0.0
    for (index, span) in spans.enumerated() {
      if index > 0 {
        let previous = spans[index - 1]
        pieces.append(Piece(isGap: true, start: previous.end, end: span.start, from: at, to: at + gapWeight / total))
        at += gapWeight / total
      }
      let width = max(span.end - span.start, 1) / total
      pieces.append(Piece(isGap: false, start: span.start, end: span.end, from: at, to: at + width))
      at += width
    }
    start = first.start
    end = last.end
    self.pieces = pieces
  }

  /// How much footage the timeline holds, gaps left out.
  public var recordedLength: Double {
    pieces.reduce(0) { $0 + ($1.isGap ? 0 : $1.end - $1.start) }
  }

  /// Where `at` sits on the track, 0 to 1; a time in a gap sits at the gap's end.
  public func position(of at: Double) -> Double {
    for piece in pieces where at <= piece.end {
      if piece.isGap { return piece.to }
      if at <= piece.start { return piece.from }
      return piece.from + (at - piece.start) / nonZero(piece.end - piece.start) * (piece.to - piece.from)
    }
    return 1
  }

  /// The time at `position` on the track; a gap resolves to the start of the recording after it.
  public func time(at position: Double) -> Double {
    let clamped = min(1, max(0, position))
    for piece in pieces where clamped <= piece.to {
      if piece.isGap { return piece.end }
      return piece.start + (clamped - piece.from) / nonZero(piece.to - piece.from) * (piece.end - piece.start)
    }
    return end
  }

  /// Where to land for a marker: a little before it, so the action plays out on screen.
  public func seekTime(for marker: ReplayMarker, leadMs: Double = 1500) -> Double {
    let before = marker.at - leadMs
    let piece = pieces.first { !$0.isGap && marker.at <= $0.end }
    return max(before, piece?.start ?? start)
  }

  /// Where to step from to the next or previous agent action: the action last stepped to, until playback carries the
  /// playhead past it. `seekTime(for:)` lands before the action, or after it when clamped to the start of its footage,
  /// so while paused the playhead alone would step to the same action again.
  public static func stepFrom(_ at: Double, stepped: Double?, playing: Bool) -> Double {
    if let stepped, !playing || at <= stepped { return stepped }
    return at
  }

  /// The first agent action after `from`, or with `forward` false the last one before it; nil when there is none.
  public static func adjacentAction(_ markers: [ReplayMarker], from: Double, forward: Bool) -> ReplayMarker? {
    let actions = markers.filter { $0.kind == "action" }
    return forward
      ? actions.filter { $0.at > from }.min { $0.at < $1.at }
      : actions.filter { $0.at < from }.max { $0.at < $1.at }
  }

  private func nonZero(_ value: Double) -> Double { value == 0 ? 1 : value }

  /// "2h", "14m", "40s": how long a gap or an age is, in its largest unit.
  public static func shortDuration(ms: Double) -> String {
    let seconds = max(0, Int((ms / 1000).rounded()))
    if seconds < 60 { return "\(seconds)s" }
    let minutes = Int((Double(seconds) / 60).rounded())
    if minutes < 60 { return "\(minutes)m" }
    let hours = Int((Double(minutes) / 60).rounded())
    return hours < 48 ? "\(hours)h" : "\(Int((Double(hours) / 24).rounded()))d"
  }
}
