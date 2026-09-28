import AppKit
import CoreVideo
import EmulatorFrames
import StimKit
import SwiftUI

/// Shows the H.264 footage a `ReplayController` receives.
struct ReplayScreen: NSViewRepresentable {
  @ObservedObject var controller: ReplayController
  var onPixelSizeChange: (CGSize) -> Void

  func makeNSView(context: Context) -> ReplayScreenView {
    let view = ReplayScreenView()
    view.onPixelSizeChange = onPixelSizeChange
    controller.onVideo = { [weak view] packet in view?.show(packet) }
    return view
  }

  func updateNSView(_ view: ReplayScreenView, context: Context) {
    view.onPixelSizeChange = onPixelSizeChange
  }

  static func dismantleNSView(_ view: ReplayScreenView, coordinator: ()) {
    view.invalidate()
  }
}

final class ReplayScreenView: NSView {
  private final class Decoding {
    var configured = false
    var decoder: H264Decoder?
  }

  var onPixelSizeChange: (CGSize) -> Void = { _ in }
  private var size: CGSize?
  private let queue = DispatchQueue(label: "dev.stim.desktop.replay-decode")
  private let decoding = Decoding()

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer = CALayer()
    layer?.contentsGravity = .resizeAspect
    layer?.minificationFilter = .trilinear
    decoding.decoder = H264Decoder { [weak self] image in
      guard let surface = CVPixelBufferGetIOSurface(image)?.takeUnretainedValue() else { return }
      DispatchQueue.main.async { self?.layer?.contents = surface }
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  @MainActor func show(_ packet: VideoPacket) {
    queue.async { [decoding] in
      guard let decoder = decoding.decoder else { return }
      if packet.keyframe { decoding.configured = decoder.configure(packet.accessUnit) }
      if decoding.configured { decoding.configured = decoder.decode(packet.accessUnit) }
    }
    let size = CGSize(width: packet.width, height: packet.height)
    if size != self.size {
      self.size = size
      onPixelSizeChange(size)
    }
  }

  func invalidate() {
    queue.async { [decoding] in decoding.decoder?.invalidate() }
  }
}

/// Owns one device slot's `ReplayController` while its tile shows, polling through Stim Desktop's stim-server
/// connection.
struct ReplayHost<Content: View>: View {
  var target: ReplayTarget
  @ViewBuilder var content: (ReplayController) -> Content
  @ObservedObject private var session = ServerSession.shared
  @StateObject private var controller: ReplayController

  init(target: ReplayTarget, @ViewBuilder content: @escaping (ReplayController) -> Content) {
    self.target = target
    self.content = content
    _controller = StateObject(wrappedValue: ReplayController(target: target))
  }

  var body: some View {
    content(controller)
      .onAppear(perform: attach)
      .onChange(of: session.state) { _, _ in attach() }
      .onDisappear { controller.stop() }
  }

  /// A connection that drops keeps the controller, since the client subscribes again once it reconnects.
  private func attach() {
    if session.client == nil {
      controller.connect(nil)
    } else if session.isOpen {
      controller.connect(session.client)
    }
  }
}

/// Live, play and pause, speed, and a scrubber over the device's recorded footage with its agent actions and errors
/// as markers, as the phone's `ReplayBar` offers them. Without a timeline, while replay shows footage that is gone,
/// only Live. Dragging shows the frame under the pointer; clicking near a marker lands just before it; hovering a
/// marker shows what happened.
struct ReplayBar: View {
  @ObservedObject var controller: ReplayController
  var running: Bool
  var replayOff: Bool
  var onSeek: () -> Void = {}

  @State private var speed = 1

  var body: some View {
    let timeline = replayOff || controller.replayable == false ? nil : controller.timeline
    VStack(alignment: .leading, spacing: Space.sm) {
      HStack(spacing: Space.md) {
        liveButton
        if let timeline {
          playButton(timeline)
          Button("\(speed)x") { toggleSpeed() }
            .buttonStyle(.stim())
            .fixedSize()
            .help("Playback speed")
          TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(caption(timeline, now: context.date))
              .font(.stim(.caption, mono: true))
              .foregroundStyle(Palette.secondary)
              .lineLimit(1)
          }
        }
        Spacer(minLength: 0)
        if replayOff {
          Pill(tone: .neutral, size: .small) { Text("Replay off") }
            .help("recording.enabled is false for this workspace, so stim-server records none of its screens.")
        } else if controller.range?.recording == true {
          Pill(tone: .error, size: .small) {
            Circle().fill(Palette.error).frame(width: 6, height: 6)
            Text("Recording")
          }
          .help("stim-server records this screen; the last 15 minutes can be replayed.")
        }
      }
      if let timeline {
        ReplayTrack(
          timeline: timeline, markers: controller.range?.markers ?? [], shownAt: controller.replay?.at,
          isLive: controller.replay == nil, seek: seek)
      }
      if let error = controller.error {
        Text(error).font(.stim(.caption)).foregroundStyle(Palette.warning).lineLimit(2)
      }
    }
  }

  private var liveButton: some View {
    let isLive = controller.replay == nil
    return Button {
      controller.live()
    } label: {
      HStack(spacing: Space.xs) {
        Circle().fill(isLive && running ? Palette.error : Palette.tertiary).frame(width: 6, height: 6)
        Text("Live")
      }
    }
    .buttonStyle(.stim(isLive ? .primary : .secondary))
    .fixedSize()
    .disabled(isLive)
    .help(running ? "Show the live screen" : "Leave the replay; the device is not running")
  }

  private func playButton(_ timeline: ReplayTimeline) -> some View {
    let replay = controller.replay
    let playing = replay.map { $0.rate > 0 && !$0.ended } ?? false
    return Button {
      if let replay, playing {
        seek(replay.at ?? timeline.start, rate: 0)
      } else if let replay, !replay.ended, let at = replay.at {
        seek(at, rate: speed)
      } else {
        seek(timeline.start, rate: speed)
      }
    } label: {
      Image(systemName: playing ? "pause.fill" : "play.fill")
    }
    .buttonStyle(.stim())
    .fixedSize()
    .help(playing ? "Pause" : "Play the recording")
    .accessibilityLabel(playing ? "Pause" : "Play")
  }

  private func toggleSpeed() {
    speed = speed == 1 ? 2 : 1
    if let replay = controller.replay, replay.rate > 0, !replay.ended, let at = replay.at { seek(at, rate: speed) }
  }

  private func caption(_ timeline: ReplayTimeline, now: Date) -> String {
    guard let replay = controller.replay else {
      return "Replay \(ReplayTimeline.shortDuration(ms: timeline.recordedLength)) recorded"
    }
    guard let at = replay.at else { return "Loading..." }
    let date = Date(timeIntervalSince1970: at / 1000)
    let ago = ReplayTimeline.shortDuration(ms: now.timeIntervalSince(date) * 1000)
    return "\(date.formatted(date: .omitted, time: .standard)) \u{00B7} \(ago) ago\(replay.ended ? " \u{00B7} end" : "")"
  }

  private func seek(_ at: Double, rate: Int) {
    onSeek()
    controller.seek(at: at, rate: rate)
  }
}

/// The scrubber: recorded spans, gaps, markers and the playhead. Hovering shows the time or the marker under the
/// pointer in a tooltip, at most 30 times a second and without touching the layout; dragging shows the frame under
/// the pointer, and a click near a marker lands just before it.
struct ReplayTrack: View {
  var timeline: ReplayTimeline
  var markers: [ReplayMarker]
  /// The time of the frame shown; nil before the first frame.
  var shownAt: Double?
  var isLive: Bool
  var seek: (_ at: Double, _ rate: Int) -> Void

  private static let markerReach: CGFloat = 6
  private static let dragThreshold: CGFloat = 3
  private static let tooltipWidth: CGFloat = 280
  private static let accessibilityStepMs = 5000.0
  @State private var dragging: CGFloat?
  @State private var hover = ReplayHover()
  @State private var width: CGFloat = 0

  var body: some View {
    let position = dragging.map { fraction($0) } ?? (isLive ? 1 : shownAt.map(timeline.position(of:)) ?? 1)
    ZStack(alignment: .topLeading) {
      ForEach(Array(timeline.pieces.enumerated()), id: \.offset) { _, piece in
        let x = piece.from * width
        let w = max(1, (piece.to - piece.from) * width)
        if piece.isGap {
          Rectangle().fill(Palette.border).frame(width: w, height: 2).offset(x: x, y: 13)
        } else {
          RoundedRectangle(cornerRadius: Radius.small).fill(Palette.raised).frame(width: w, height: 16).offset(x: x, y: 6)
        }
      }
      ForEach(markers, id: \.self) { marker in
        RoundedRectangle(cornerRadius: 1)
          .fill(color(marker))
          .frame(width: 3, height: 16)
          .offset(x: timeline.position(of: marker.at) * width - 1.5, y: 6)
      }
      Rectangle()
        .fill(isLive ? Palette.tertiary : Palette.text)
        .frame(width: 2, height: 24)
        .offset(x: position * width - 1, y: 2)
    }
    .frame(height: 28)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .overlay(alignment: .topLeading) {
      ReplayTooltipLayer(
        hover: hover, dragging: dragging, maxWidth: min(Self.tooltipWidth, width),
        text: { x, marker in tooltipText(x: x, marker: marker) })
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    .onContinuousHover { phase in
      switch phase {
      case .active(let point): hover.move(to: point.x.rounded(), marker: nearestMarker(x: point.x.rounded()))
      case .ended: hover.move(to: nil, marker: nil)
      }
    }
    .gesture(
      DragGesture(minimumDistance: 0)
        .onChanged { drag in
          guard dragging != nil || abs(drag.translation.width) >= Self.dragThreshold else { return }
          let x = min(max(0, drag.location.x), width)
          guard x != dragging else { return }
          dragging = x
          seek(timeline.time(at: fraction(x)), 0)
        }
        .onEnded { drag in
          let x = min(max(0, drag.location.x), width)
          let dragged = dragging != nil
          dragging = nil
          if dragged { hover.move(to: nil, marker: nil) }
          if !dragged, let marker = nearestMarker(x: x) {
            seek(timeline.seekTime(for: marker), 0)
          } else {
            seek(timeline.time(at: fraction(x)), 0)
          }
        })
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Replay timeline")
    .accessibilityValue(accessibilityValue)
    .accessibilityAdjustableAction { direction in
      let from = isLive ? timeline.end : shownAt ?? timeline.end
      switch direction {
      case .increment: seek(min(timeline.end, from + Self.accessibilityStepMs), 0)
      case .decrement: seek(max(timeline.start, from - Self.accessibilityStepMs), 0)
      @unknown default: break
      }
    }
  }

  private var accessibilityValue: String {
    guard !isLive, let shownAt else { return "Live" }
    let time = Date(timeIntervalSince1970: shownAt / 1000).formatted(date: .omitted, time: .standard)
    let recent = markers.last { $0.at <= shownAt && shownAt - $0.at <= Self.accessibilityStepMs }
    return recent.map { "\(time), \($0.title): \($0.label)" } ?? time
  }

  private func fraction(_ x: CGFloat) -> Double { x / max(width, 1) }

  private func nearestMarker(x: CGFloat) -> ReplayMarker? {
    markers
      .map { ($0, abs(timeline.position(of: $0.at) * width - x)) }
      .filter { $0.1 <= Self.markerReach }
      .min { $0.1 < $1.1 }?.0
  }

  private func color(_ marker: ReplayMarker) -> Color {
    switch marker.kind {
    case "action": return Palette.accent
    case "crash": return Palette.error
    default: return Palette.warning
    }
  }

  private func tooltipText(x: CGFloat, marker: ReplayMarker?) -> String {
    let at = marker?.at ?? timeline.time(at: fraction(x))
    let time = Date(timeIntervalSince1970: at / 1000).formatted(date: .omitted, time: .standard)
    if let marker {
      return "\(marker.title)\(marker.command.map { " \u{00B7} \($0)" } ?? "") \u{00B7} \(time)\n\(marker.label)"
    }
    let gap = timeline.pieces.first { $0.isGap && fraction(x) >= $0.from && fraction(x) <= $0.to }
    return gap.map { "Not recorded for \(ReplayTimeline.shortDuration(ms: $0.end - $0.start))" } ?? time
  }

}

/// Where the pointer hovers over a `ReplayTrack`, passed to `onChange` at most `interval` apart and last where the
/// pointer stopped. It is not observable state, so hovering updates only the tooltip layer.
@MainActor final class ReplayHover {
  static let interval: TimeInterval = 1.0 / 30

  private(set) var x: CGFloat?
  private(set) var marker: ReplayMarker?
  var onChange: () -> Void = {}
  private var shownAt: TimeInterval = 0
  private var pending: (x: CGFloat?, marker: ReplayMarker?)?

  func move(to x: CGFloat?, marker: ReplayMarker?) {
    let now = ProcessInfo.processInfo.systemUptime
    guard x != nil, now - shownAt < Self.interval else {
      pending = nil
      show(x, marker, at: now)
      return
    }
    let scheduled = pending != nil
    pending = (x, marker)
    guard !scheduled else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.interval - (now - shownAt)) { [weak self] in
      guard let self, let pending = self.pending else { return }
      self.pending = nil
      self.show(pending.x, pending.marker, at: ProcessInfo.processInfo.systemUptime)
    }
  }

  private func show(_ x: CGFloat?, _ marker: ReplayMarker?, at now: TimeInterval) {
    shownAt = now
    guard x != self.x || marker != self.marker else { return }
    self.x = x
    self.marker = marker
    onChange()
  }
}

/// The track's tooltip, at the pointer while dragging and at the hover otherwise. It is plain AppKit placed by
/// frame, so following the pointer never updates or lays out the SwiftUI page around the track.
private struct ReplayTooltipLayer: NSViewRepresentable {
  var hover: ReplayHover
  var dragging: CGFloat?
  var maxWidth: CGFloat
  var text: (_ x: CGFloat, _ marker: ReplayMarker?) -> String

  func makeNSView(context: Context) -> ReplayTooltipView { ReplayTooltipView(hover: hover) }

  func updateNSView(_ view: ReplayTooltipView, context: Context) {
    view.dragging = dragging
    view.maxWidth = maxWidth
    view.text = text
    view.refresh()
  }
}

/// Draws with layers only: a subview or text field whose size changes would ask the window for a layout pass,
/// and that pass re-lays out the SwiftUI page.
final class ReplayTooltipView: NSView {
  private static let maxLines = 3

  var dragging: CGFloat?
  var maxWidth: CGFloat = 0
  var text: ((_ x: CGFloat, _ marker: ReplayMarker?) -> String)?
  private let hover: ReplayHover
  private let bubble = CALayer()
  private let label = CATextLayer()
  private let font = TextVariant.caption.nsFont()
  private var lastText: (text: String, width: CGFloat, color: NSColor, string: NSAttributedString)?

  init(hover: ReplayHover) {
    self.hover = hover
    super.init(frame: .zero)
    wantsLayer = true
    layer?.masksToBounds = false
    bubble.cornerRadius = Radius.chip
    bubble.borderWidth = 1
    bubble.shadowRadius = 6
    bubble.shadowOpacity = 0.15
    bubble.shadowOffset = .zero
    bubble.isHidden = true
    label.isWrapped = true
    label.truncationMode = .end
    let still: [String: CAAction] = [
      "contents": NSNull(), "bounds": NSNull(), "position": NSNull(), "hidden": NSNull(),
    ]
    bubble.actions = still
    label.actions = still
    bubble.addSublayer(label)
    layer?.addSublayer(bubble)
    hover.onChange = { [weak self] in self?.refresh() }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  override var isFlipped: Bool { true }

  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    refresh()
  }

  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    label.contentsScale = window?.backingScaleFactor ?? 2
  }

  func refresh() {
    guard let x = dragging ?? hover.x, let text else {
      bubble.isHidden = true
      return
    }
    var color = NSColor.clear
    effectiveAppearance.performAsCurrentDrawingAppearance {
      bubble.backgroundColor = NSColor(Palette.surface).cgColor
      bubble.borderColor = NSColor(Palette.border).cgColor
      bubble.shadowColor = NSColor(Palette.shadow).cgColor
      color = NSColor(cgColor: NSColor(Palette.text).cgColor) ?? .labelColor
    }
    let inner = max(0, maxWidth - 2 * Space.md)
    let raw = text(x, dragging == nil ? hover.marker : nil)
    let string: NSAttributedString
    if let lastText, lastText.text == raw, lastText.width == inner, lastText.color == color {
      string = lastText.string
    } else {
      string = truncated(raw, width: inner, color: color)
      lastText = (raw, inner, color, string)
    }
    let fitted = measure(string, width: inner)
    let size = CGSize(width: ceil(min(fitted.width, inner)), height: ceil(fitted.height))
    let width = size.width + 2 * Space.md
    let height = size.height + 2 * Space.xs
    let left = min(max(0, x - width / 2), max(0, bounds.width - width))
    label.string = string
    label.contentsScale = window?.backingScaleFactor ?? 2
    bubble.frame = CGRect(x: left, y: -height - Space.sm, width: width, height: height)
    label.frame = CGRect(x: Space.md, y: Space.xs, width: size.width, height: size.height)
    bubble.isHidden = false
  }

  private func measure(_ string: NSAttributedString, width: CGFloat) -> CGRect {
    string.boundingRect(
      with: NSSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin])
  }

  /// `CATextLayer` drops a wrapped line that does not fit instead of truncating it, so the text is cut to
  /// `maxLines` here.
  private func truncated(_ text: String, width: CGFloat, color: NSColor) -> NSAttributedString {
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
    let limit = measure(
      NSAttributedString(
        string: Array(repeating: "A", count: Self.maxLines).joined(separator: "\n"), attributes: attributes),
      width: width
    ).height
    let whole = NSAttributedString(string: text, attributes: attributes)
    guard measure(whole, width: width).height > limit + 0.5 else { return whole }
    var low = 0
    var high = text.count
    while low < high {
      let mid = (low + high + 1) / 2
      let candidate = NSAttributedString(string: text.prefix(mid) + "\u{2026}", attributes: attributes)
      if measure(candidate, width: width).height <= limit + 0.5 { low = mid } else { high = mid - 1 }
    }
    return NSAttributedString(string: text.prefix(low) + "\u{2026}", attributes: attributes)
  }
}
