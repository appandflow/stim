import Foundation

/// The scrubber's track, one scale for every recorded span and unrecorded gap, as the phone's `buildTimeline` lays it
/// out: a millisecond takes the same width anywhere, except in a gap longer than `longGapMs`, which takes `longGapMs`
/// and is `collapsed`. The track's `length` is rounded up to a whole `windowStepMs`, with the spare room before the
/// oldest footage, so its right edge is the newest footage. `from` and `to` are a piece's place on the track, 0 to 1.
/// Every time is a Mac capture time from `replay.range`.
public struct ReplayTimeline: Equatable, Sendable {
  public struct Piece: Equatable, Sendable {
    public var isGap: Bool
    public var start: Double
    public var end: Double
    public var from: Double
    public var to: Double
    /// A gap longer than `longGapMs`, drawn at `longGapMs`.
    public var collapsed = false
  }

  /// A "stopped" label under a gap, `left` and `width` in points along the track.
  public struct GapLabel: Equatable, Sendable {
    public var start: Double
    public var text: String
    public var left: Double
    public var width: Double
  }

  /// A stop longer than this takes only this much of the track, so hours stopped do not squeeze the footage flat.
  public static let longGapMs = 60_000.0
  /// The track's length is a whole number of these, so it rescales at most once per step as footage grows. It shrinks
  /// only by two steps or more, so footage that hovers around a step as stim-server prunes it does not flip the scale.
  public static let windowStepMs = 60_000.0
  static let labelCharWidth = 6.5
  static let labelGap = 6.0

  public var start: Double
  public var end: Double
  public var spans: [ReplaySpan]
  /// The track's length in milliseconds of track time.
  public var length: Double
  public var pieces: [Piece]

  /// A device still recorded ends at its newest footage, or at `liveEnd` when that is later, the Mac's estimated time
  /// now. `previousLength` is the length of the track shown before, which the new one keeps unless footage grew past
  /// it or shrank by two steps.
  public init?(spans: [ReplaySpan], liveEnd: Double? = nil, previousLength: Double? = nil) {
    guard let last = spans.last else { return nil }
    var shown = spans
    if let liveEnd, liveEnd > last.end { shown[shown.count - 1] = ReplaySpan(start: last.start, end: liveEnd) }
    var weights: [Double] = []
    for (index, span) in shown.enumerated() {
      let gap = index > 0 ? min(span.start - shown[index - 1].end, Self.longGapMs) : 0
      weights.append(max(gap, 0))
      weights.append(max(span.end - span.start, 1))
    }
    let total = weights.reduce(0, +)
    let fitted = max(1, (total / Self.windowStepMs).rounded(.up)) * Self.windowStepMs
    let length =
      if let previousLength, fitted < previousLength, previousLength - fitted < 2 * Self.windowStepMs {
        previousLength
      } else {
        fitted
      }
    var pieces: [Piece] = []
    var at = length - total
    for (index, span) in shown.enumerated() {
      if index > 0 {
        let previous = shown[index - 1]
        let weight = weights[index * 2]
        pieces.append(
          Piece(
            isGap: true, start: previous.end, end: span.start, from: at / length, to: (at + weight) / length,
            collapsed: span.start - previous.end > Self.longGapMs))
        at += weight
      }
      let weight = weights[index * 2 + 1]
      pieces.append(
        Piece(isGap: false, start: span.start, end: span.end, from: at / length, to: (at + weight) / length))
      at += weight
    }
    start = shown[0].start
    end = shown[shown.count - 1].end
    self.spans = spans
    self.length = length
    self.pieces = pieces
  }

  /// How much footage the timeline holds, gaps left out.
  public var recordedLength: Double {
    spans.reduce(0) { $0 + ($1.end - $1.start) }
  }

  /// Where `at` sits on the track, 0 to 1; a time before the oldest footage sits where the footage starts.
  public func position(of at: Double) -> Double {
    for piece in pieces where at <= piece.end {
      if at <= piece.start { return piece.from }
      return piece.from + (at - piece.start) / nonZero(piece.end - piece.start) * (piece.to - piece.from)
    }
    return 1
  }

  /// The time at `position` on the track. A gap resolves to the start of the recording after it, and the room before
  /// the oldest footage to its start.
  public func time(at position: Double) -> Double {
    let clamped = min(1, max(0, position))
    for piece in pieces where clamped <= piece.to {
      if piece.isGap { return piece.end }
      if clamped <= piece.from { return piece.start }
      return piece.start + (clamped - piece.from) / nonZero(piece.to - piece.from) * (piece.end - piece.start)
    }
    return end
  }

  /// The "stopped" labels to draw under the track's gaps, at most one per place: each is centred under its gap and
  /// kept inside the track, and a label that would overlap a longer stop's is left out. `width` is the track's in
  /// points; `measure` gives a label's width, by default estimated from its length as the phone does.
  public func gapLabels(width: Double, measure: (String) -> Double = Self.estimatedWidth) -> [GapLabel] {
    var placed: [GapLabel] = []
    let gaps = pieces.filter(\.isGap).sorted { $0.end - $0.start > $1.end - $1.start }
    for gap in gaps {
      let text = "stopped \(Format.roundedDuration(ms: gap.end - gap.start))"
      let labelWidth = measure(text).rounded(.up)
      if labelWidth > width { continue }
      let center = (gap.from + gap.to) / 2 * width
      let left = min(max(0, center - labelWidth / 2), width - labelWidth)
      let overlaps = placed.contains {
        left < $0.left + $0.width + Self.labelGap && $0.left < left + labelWidth + Self.labelGap
      }
      if !overlaps { placed.append(GapLabel(start: gap.start, text: text, left: left, width: labelWidth)) }
    }
    return placed.sorted { $0.left < $1.left }
  }

  public static func estimatedWidth(_ text: String) -> Double { Double(text.count) * labelCharWidth }

  /// Where to land for a marker: a little before it, so the action plays out on screen.
  public func seekTime(for marker: ReplayMarker, leadMs: Double = 1500) -> Double {
    let before = marker.at - leadMs
    let piece = pieces.first { !$0.isGap && marker.at <= $0.end }
    return max(before, piece?.start ?? start)
  }

  /// Where to land for an agent action at `at`, as `seekTime(for:)` does for a marker, or nil when no recorded span
  /// covers it.
  public func seekTime(forActionAt at: Double, leadMs: Double = 1500) -> Double? {
    guard let span = spans.first(where: { $0.start <= at && at <= $0.end }) else { return nil }
    return max(at - leadMs, span.start)
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
}
