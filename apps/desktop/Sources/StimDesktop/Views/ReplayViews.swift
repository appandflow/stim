import AppKit
import CoreVideo
import EmulatorFrames
import StimKit
import SwiftUI
import VideoToolbox

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

/// Decodes the keyframes of replay previews with its own `H264Decoder` on its own queue, apart from playback, into
/// images at most `maxPixels` on their longer side.
final class ReplayPreviewDecoder {
  static let shared = ReplayPreviewDecoder()
  static let maxPixels = 320

  private let queue = DispatchQueue(label: "dev.stim.desktop.replay-previews", qos: .utility)
  private var decoder: H264Decoder?
  private var frame: CVPixelBuffer?

  /// VideoToolbox calls the output handler before `VTDecompressionSessionDecodeFrame` returns when the decode is
  /// not asynchronous, so the frame is ready once `decode` returns.
  func decode(_ keyframe: ReplayKeyframe, done: @escaping @MainActor (CGImage?) -> Void) {
    queue.async { [self] in
      let decoder = self.decoder ?? H264Decoder { [unowned self] in self.frame = $0 }
      self.decoder = decoder
      frame = nil
      if decoder.configure(keyframe.accessUnit) { decoder.decode(keyframe.accessUnit) }
      let image = frame.flatMap(Self.thumbnail)
      frame = nil
      Task { @MainActor in done(image) }
    }
  }

  private static func thumbnail(_ buffer: CVPixelBuffer) -> CGImage? {
    var full: CGImage?
    guard VTCreateCGImageFromCVPixelBuffer(buffer, options: nil, imageOut: &full) == noErr, let full else { return nil }
    let scale = min(1, Double(maxPixels) / Double(max(full.width, full.height, 1)))
    let width = max(1, Int((Double(full.width) * scale).rounded()))
    let height = max(1, Int((Double(full.height) * scale).rounded()))
    guard
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    context.interpolationQuality = .high
    context.draw(full, in: CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()
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
    _controller = StateObject(wrappedValue: Self.controller(target))
  }

  private static func controller(_ target: ReplayTarget) -> ReplayController {
    let controller = ReplayController(target: target)
    controller.previews.decode = ReplayPreviewDecoder.shared.decode
    return controller
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
/// marker shows what happened. While live, play and pause shows pause, and pausing freezes on the newest frame.
struct ReplayBar: View {
  /// stim-server's `frames.seek` shows the newest frame for a time past every recording; the phone sends the same.
  private static let newestFrame = 9_007_199_254_740_991.0

  @ObservedObject var controller: ReplayController
  var running: Bool
  var replayOff: Bool
  var onSeek: () -> Void = {}

  @State private var speed = 1
  /// The agent action the last step went to, so the next step counts from it; nil after any other seek.
  @State private var stepped: Double?

  var body: some View {
    let timeline = replayOff || controller.replayable == false ? nil : controller.timeline
    VStack(alignment: .leading, spacing: Space.sm) {
      HStack(spacing: Space.md) {
        liveButton
        if let timeline {
          stepButton(timeline, forward: false)
          playButton(timeline)
          stepButton(timeline, forward: true)
          Button("\(speed)x") { toggleSpeed() }
            .buttonStyle(.stim())
            .fixedSize()
            .help("Playback speed")
            .opacity(isLive ? 0 : 1)
            .disabled(isLive)
            .accessibilityHidden(isLive)
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
        TimelineView(.periodic(from: .now, by: 1)) { _ in
          ReplayTrack(
            timeline: timeline, liveEnd: controller.liveEnd(running: running),
            markers: controller.range?.markers ?? [], shownAt: controller.replay?.at,
            isLive: controller.replay == nil, previews: controller.previews, seek: { seek($0, rate: $1) })
        }
      }
      if let error = controller.error {
        Text(error).font(.stim(.caption)).foregroundStyle(Palette.warning).lineLimit(2)
      }
    }
  }

  private var isLive: Bool { controller.replay == nil && running }

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

  /// Steps to the previous or next agent action, as the phone's replay bar does; next with none left goes live while
  /// the device runs.
  private func stepButton(_ timeline: ReplayTimeline, forward: Bool) -> some View {
    let replay = controller.replay
    let isLive = replay == nil && running
    let playing = replay.map { $0.rate > 0 && !$0.ended } ?? false
    let from = ReplayTimeline.stepFrom(
      replay?.at ?? timeline.end, stepped: replay == nil ? nil : stepped, playing: playing)
    let target = ReplayTimeline.adjacentAction(controller.range?.markers ?? [], from: from, forward: forward)
    let goesLive = forward && target == nil && running
    return Button {
      if let target {
        seek(timeline.seekTime(for: target), rate: playing ? speed : 0, action: target.at)
      } else if goesLive {
        controller.live()
      }
    } label: {
      Image(systemName: forward ? "forward.end.fill" : "backward.end.fill")
    }
    .buttonStyle(.stim())
    .fixedSize()
    .disabled(isLive || (target == nil && !goesLive))
    .help(forward ? (goesLive ? "No later agent action; go live" : "Next agent action") : "Previous agent action")
    .accessibilityLabel(
      forward ? (goesLive ? "Next agent action, none; go live" : "Next agent action") : "Previous agent action")
  }

  private func playButton(_ timeline: ReplayTimeline) -> some View {
    let replay = controller.replay
    let playing = replay.map { $0.rate > 0 && !$0.ended } ?? false
    let showsPause = playing || isLive
    return Button {
      if isLive {
        seek(Self.newestFrame, rate: 0)
      } else if let replay, playing {
        seek(replay.at ?? timeline.start, rate: 0)
      } else if let replay, !replay.ended, let at = replay.at {
        seek(at, rate: speed)
      } else {
        seek(timeline.start, rate: speed)
      }
    } label: {
      Image(systemName: showsPause ? "pause.fill" : "play.fill")
    }
    .buttonStyle(.stim())
    .fixedSize()
    .help(isLive ? "Pause on the current frame" : playing ? "Pause" : "Play the recording")
    .accessibilityLabel(showsPause ? "Pause" : "Play")
  }

  private func toggleSpeed() {
    speed = speed == 1 ? 2 : 1
    if let replay = controller.replay, replay.rate > 0, !replay.ended, let at = replay.at {
      seek(at, rate: speed, action: stepped)
    }
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

  private func seek(_ at: Double, rate: Int, action: Double? = nil) {
    stepped = action
    onSeek()
    controller.seek(at: at, rate: rate)
  }
}

/// The scrubber: recorded spans, gaps with "stopped" labels, markers and the playhead, on one linear scale. Hovering
/// shows the time or the marker under the pointer in a tooltip, at most 30 times a second and without touching the
/// layout, above a still frame of the recorded segment of about 5 seconds there; dragging shows the frame under the
/// pointer on the screen, and a click near a marker lands just before it. While the device runs and is recorded, the
/// track ends at `liveEnd`; hovering or dragging holds the track still until the pointer leaves or the drag ends.
struct ReplayTrack: View {
  var timeline: ReplayTimeline
  var liveEnd: Double?
  var markers: [ReplayMarker]
  /// The time of the frame shown; nil before the first frame.
  var shownAt: Double?
  var isLive: Bool
  var previews: ReplayPreviews
  var seek: (_ at: Double, _ rate: Int) -> Void

  private static let markerReach: CGFloat = 6
  private static let dragThreshold: CGFloat = 3
  private static let tooltipWidth: CGFloat = 280
  private static let accessibilityStepMs = 5000.0
  private static let barHeight: CGFloat = 28
  private static let labelHeight: CGFloat = 16
  @State private var dragging: CGFloat?
  @State private var hover = ReplayHover()
  @State private var width: CGFloat = 0
  @State private var held: ReplayTimeline?
  @State private var trackLength: Double?

  private var track: ReplayTimeline {
    held ?? ReplayTimeline(spans: timeline.spans, liveEnd: liveEnd, previousLength: trackLength) ?? timeline
  }

  var body: some View {
    let track = self.track
    let position = dragging.map { fraction($0) } ?? (isLive ? 1 : shownAt.map(track.position(of:)) ?? 1)
    let hasGaps = track.pieces.contains(where: \.isGap)
    ZStack(alignment: .topLeading) {
      ForEach(Array(track.pieces.enumerated()), id: \.offset) { _, piece in
        let x = piece.from * width
        let w = max(1, (piece.to - piece.from) * width)
        if piece.collapsed {
          Path { path in
            path.move(to: CGPoint(x: 0, y: 1))
            path.addLine(to: CGPoint(x: w, y: 1))
          }
          .stroke(Palette.tertiary, style: StrokeStyle(lineWidth: 2, dash: [4, 3]))
          .frame(width: w, height: 2)
          .offset(x: x, y: 13)
        } else if piece.isGap {
          Rectangle().fill(Palette.border).frame(width: w, height: 2).offset(x: x, y: 13)
        } else {
          RoundedRectangle(cornerRadius: Radius.small).fill(Palette.raised).frame(width: w, height: 16)
            .offset(x: x, y: 6)
        }
      }
      ForEach(track.gapLabels(width: width, measure: Self.labelWidth), id: \.start) { label in
        Text(label.text)
          .font(.stim(.caption2))
          .foregroundStyle(Palette.tertiary)
          .lineLimit(1)
          .fixedSize()
          .frame(width: label.width)
          .offset(x: label.left, y: Self.barHeight)
      }
      ForEach(markers, id: \.self) { marker in
        RoundedRectangle(cornerRadius: 1)
          .fill(color(marker))
          .frame(width: 3, height: 16)
          .offset(x: track.position(of: marker.at) * width - 1.5, y: 6)
      }
      Rectangle()
        .fill(isLive ? Palette.tertiary : Palette.text)
        .frame(width: 2, height: 24)
        .offset(x: position * width - 1, y: 2)
    }
    .frame(height: Self.barHeight + (hasGaps ? Self.labelHeight : 0), alignment: .top)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .overlay(alignment: .topLeading) {
      ReplayTooltipLayer(
        hover: hover, dragging: dragging, maxWidth: min(Self.tooltipWidth, width), previews: previews,
        range: track.start...max(track.start, track.spans.last?.end ?? track.end),
        text: { x, marker in tooltipText(x: x, marker: marker) },
        previewTime: { x, marker in previewTime(x: x, marker: marker) })
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    .onChange(of: track.length, initial: true) { _, length in trackLength = length }
    .onContinuousHover { phase in
      switch phase {
      case .active(let point):
        hover.inside = true
        if held == nil { held = track }
        hover.move(to: point.x.rounded(), marker: nearestMarker(x: point.x.rounded()))
      case .ended:
        hover.inside = false
        if dragging == nil { held = nil }
        hover.move(to: nil, marker: nil)
      }
    }
    .gesture(
      DragGesture(minimumDistance: 0)
        .onChanged { drag in
          guard dragging != nil || abs(drag.translation.width) >= Self.dragThreshold else { return }
          if held == nil { held = track }
          let x = min(max(0, drag.location.x), width)
          guard x != dragging else { return }
          dragging = x
          seek(self.track.time(at: fraction(x)), 0)
        }
        .onEnded { drag in
          let x = min(max(0, drag.location.x), width)
          let dragged = dragging != nil
          let track = self.track
          dragging = nil
          if !hover.inside { held = nil }
          if dragged { hover.move(to: nil, marker: nil) }
          if !dragged, let marker = nearestMarker(x: x) {
            seek(track.seekTime(for: marker), 0)
          } else {
            seek(track.time(at: fraction(x)), 0)
          }
        })
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Replay timeline")
    .accessibilityValue(accessibilityValue)
    .accessibilityAdjustableAction { direction in
      let from = isLive ? timeline.end : shownAt ?? timeline.end
      switch direction {
      case .increment:
        if !isLive { seek(min(timeline.end, from + Self.accessibilityStepMs), 0) }
      case .decrement:
        let back = max(timeline.start, from - Self.accessibilityStepMs)
        let gap = timeline.pieces.first { $0.isGap && back > $0.start && back < $0.end }
        seek(gap?.start ?? back, 0)
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

  private static func labelWidth(_ text: String) -> Double {
    NSAttributedString(string: text, attributes: [.font: TextVariant.caption2.nsFont()]).size().width
  }

  private func nearestMarker(x: CGFloat) -> ReplayMarker? {
    let track = self.track
    return markers
      .map { ($0, abs(track.position(of: $0.at) * width - x)) }
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

  private func previewTime(x: CGFloat, marker: ReplayMarker?) -> Double? {
    if let marker { return marker.at }
    let at = fraction(x)
    let track = self.track
    return track.pieces.contains { $0.isGap && at >= $0.from && at <= $0.to } ? nil : track.time(at: at)
  }

  private func tooltipText(x: CGFloat, marker: ReplayMarker?) -> String {
    let track = self.track
    let at = marker?.at ?? track.time(at: fraction(x))
    let time = Date(timeIntervalSince1970: at / 1000).formatted(date: .omitted, time: .standard)
    if let marker {
      return "\(marker.title)\(marker.command.map { " \u{00B7} \($0)" } ?? "") \u{00B7} \(time)\n\(marker.label)"
    }
    let gap = track.pieces.first { $0.isGap && fraction(x) >= $0.from && fraction(x) <= $0.to }
    return gap.map { "Not recorded for \(ReplayTimeline.shortDuration(ms: $0.end - $0.start))" } ?? time
  }

}

/// Where the pointer hovers over a `ReplayTrack`, passed to `onChange` at most `interval` apart and last where the
/// pointer stopped. It is not observable state, so hovering updates only the tooltip layer.
@MainActor final class ReplayHover {
  static let interval: TimeInterval = 1.0 / 30

  private(set) var x: CGFloat?
  private(set) var marker: ReplayMarker?
  var inside = false
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
  var previews: ReplayPreviews
  var range: ClosedRange<Double>
  var text: (_ x: CGFloat, _ marker: ReplayMarker?) -> String
  var previewTime: (_ x: CGFloat, _ marker: ReplayMarker?) -> Double?

  func makeNSView(context: Context) -> ReplayTooltipView { ReplayTooltipView(hover: hover, previews: previews) }

  func updateNSView(_ view: ReplayTooltipView, context: Context) {
    view.dragging = dragging
    view.maxWidth = maxWidth
    view.range = range
    view.text = text
    view.previewTime = previewTime
    view.refresh()
  }
}

/// Draws with layers only: a subview or text field whose size changes would ask the window for a layout pass,
/// and that pass re-lays out the SwiftUI page.
final class ReplayTooltipView: NSView {
  private static let maxLines = 3
  /// The longer side of a preview, in points; `ReplayPreviewDecoder.maxPixels` covers it at 2x.
  private static let previewSide: CGFloat = 160

  var dragging: CGFloat?
  var maxWidth: CGFloat = 0
  var range: ClosedRange<Double> = 0...0
  var text: ((_ x: CGFloat, _ marker: ReplayMarker?) -> String)?
  var previewTime: ((_ x: CGFloat, _ marker: ReplayMarker?) -> Double?)?
  private let hover: ReplayHover
  private let previews: ReplayPreviews
  private let bubble = CALayer()
  private let label = CATextLayer()
  private let preview = CALayer()
  private let font = TextVariant.caption.nsFont()
  private var lastText: (text: String, width: CGFloat, color: NSColor, string: NSAttributedString)?

  init(hover: ReplayHover, previews: ReplayPreviews) {
    self.hover = hover
    self.previews = previews
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
    preview.cornerRadius = Radius.small
    preview.masksToBounds = true
    preview.contentsGravity = .resizeAspect
    preview.minificationFilter = .trilinear
    bubble.actions = still
    label.actions = still
    preview.actions = still
    bubble.addSublayer(preview)
    bubble.addSublayer(label)
    layer?.addSublayer(bubble)
    hover.onChange = { [weak self] in self?.refresh() }
    previews.onImage = { [weak self] in self?.refresh() }
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
      previews.want(nil, within: range)
      bubble.isHidden = true
      return
    }
    let wanted = dragging == nil && previews.isAvailable ? previewTime?(x, hover.marker) : nil
    previews.want(wanted, within: range)
    let previewAt = previews.aspect == nil ? nil : wanted
    var color = NSColor.clear
    effectiveAppearance.performAsCurrentDrawingAppearance {
      bubble.backgroundColor = NSColor(Palette.surface).cgColor
      bubble.borderColor = NSColor(Palette.border).cgColor
      bubble.shadowColor = NSColor(Palette.shadow).cgColor
      preview.backgroundColor = NSColor(Palette.raised).cgColor
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
    let box = previewAt.map { _ in previewSize(maxWidth: inner) } ?? .zero
    let top = box.height > 0 ? box.height + Space.xs : 0
    let width = max(size.width, box.width) + 2 * Space.md
    let height = top + size.height + 2 * Space.xs
    let left = min(max(0, x - width / 2), max(0, bounds.width - width))
    label.string = string
    label.contentsScale = window?.backingScaleFactor ?? 2
    bubble.frame = CGRect(x: left, y: -height - Space.sm, width: width, height: height)
    preview.isHidden = previewAt == nil
    preview.contents = previewAt.flatMap(previews.image(at:))
    preview.frame = CGRect(x: (width - box.width) / 2, y: Space.xs, width: box.width, height: box.height)
    label.frame = CGRect(x: Space.md, y: Space.xs + top, width: size.width, height: size.height)
    bubble.isHidden = false
  }

  /// The box has the aspect of the newest keyframe the server answered, and shows only once there is one, so a
  /// frame arriving fills the box without resizing it.
  private func previewSize(maxWidth: CGFloat) -> CGSize {
    let aspect = CGFloat(previews.aspect ?? 1)
    let size =
      aspect < 1
      ? CGSize(width: Self.previewSide * aspect, height: Self.previewSide)
      : CGSize(width: Self.previewSide, height: Self.previewSide / aspect)
    let fit = min(1, maxWidth / max(size.width, 1))
    return CGSize(width: (size.width * fit).rounded(), height: (size.height * fit).rounded())
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
