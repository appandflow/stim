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
    view.decoder.invalidate()
  }
}

final class ReplayScreenView: NSView {
  var onPixelSizeChange: (CGSize) -> Void = { _ in }
  private var size: CGSize?
  private var configured = false
  lazy var decoder = H264Decoder { [weak self] image in
    guard let surface = CVPixelBufferGetIOSurface(image)?.takeUnretainedValue() else { return }
    DispatchQueue.main.async { self?.layer?.contents = surface }
  }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer = CALayer()
    layer?.contentsGravity = .resizeAspect
    layer?.minificationFilter = .trilinear
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

  @MainActor func show(_ packet: VideoPacket) {
    if packet.keyframe { configured = decoder.configure(packet.accessUnit) }
    guard configured else { return }
    decoder.decode(packet.accessUnit)
    let size = CGSize(width: packet.width, height: packet.height)
    if size != self.size {
      self.size = size
      onPixelSizeChange(size)
    }
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
      .onAppear { controller.connect(session.isOpen ? session.client : nil) }
      .onChange(of: session.state) { _, _ in controller.connect(session.isOpen ? session.client : nil) }
      .onDisappear { controller.stop() }
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

  private static let dragSeekInterval: TimeInterval = 0.12
  private static let markerReach: CGFloat = 6
  @State private var speed = 1
  @State private var dragging: Double?
  @State private var lastSeek = Date.distantPast
  @State private var hover: (x: CGFloat, marker: ReplayMarker?)?
  @State private var width: CGFloat = 0

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
        track(timeline)
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

  private func track(_ timeline: ReplayTimeline) -> some View {
    let markers = controller.range?.markers ?? []
    let shownAt = controller.replay?.at
    let position = dragging ?? (controller.replay == nil ? 1 : shownAt.map(timeline.position(of:)) ?? 0)
    return ZStack(alignment: .topLeading) {
      ForEach(Array(timeline.pieces.enumerated()), id: \.offset) { _, piece in
        let x = piece.from * width
        let w = max(1, (piece.to - piece.from) * width)
        if piece.isGap {
          Rectangle().fill(Palette.border).frame(width: w, height: 2).offset(x: x, y: 13)
            .help("Not recorded for \(ReplayTimeline.shortDuration(ms: piece.end - piece.start))")
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
        .fill(controller.replay == nil ? Palette.tertiary : Palette.text)
        .frame(width: 2, height: 24)
        .offset(x: position * width - 1, y: 2)
      if let hover {
        hoverLabel(timeline, hover)
      }
    }
    .frame(height: 28)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    .onContinuousHover { phase in
      switch phase {
      case .active(let point): hover = (point.x, nearestMarker(timeline, markers, x: point.x))
      case .ended: hover = nil
      }
    }
    .gesture(
      DragGesture(minimumDistance: 0)
        .onChanged { drag in
          guard abs(drag.translation.width) >= 3 else { return }
          let fraction = min(1, max(0, drag.location.x / max(width, 1)))
          dragging = fraction
          guard Date().timeIntervalSince(lastSeek) >= Self.dragSeekInterval else { return }
          lastSeek = Date()
          seek(timeline.time(at: fraction), rate: 0)
        }
        .onEnded { drag in
          let fraction = min(1, max(0, drag.location.x / max(width, 1)))
          dragging = nil
          if abs(drag.translation.width) >= 3 {
            seek(timeline.time(at: fraction), rate: 0)
          } else if let marker = nearestMarker(timeline, markers, x: drag.location.x) {
            seek(timeline.seekTime(for: marker), rate: 0)
          } else {
            seek(timeline.time(at: fraction), rate: 0)
          }
        })
  }

  private func nearestMarker(_ timeline: ReplayTimeline, _ markers: [ReplayMarker], x: CGFloat) -> ReplayMarker? {
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

  @ViewBuilder private func hoverLabel(_ timeline: ReplayTimeline, _ hover: (x: CGFloat, marker: ReplayMarker?)) -> some View {
    let at = hover.marker?.at ?? timeline.time(at: hover.x / max(width, 1))
    let time = Date(timeIntervalSince1970: at / 1000).formatted(date: .omitted, time: .standard)
    let text =
      hover.marker.map { marker in
        "\(marker.title)\(marker.command.map { " \u{00B7} \($0)" } ?? "") \u{00B7} \(time)\n\(marker.label)"
      } ?? time
    Text(text)
      .font(.stim(.caption))
      .foregroundStyle(Palette.text)
      .lineLimit(3)
      .fixedSize()
      .padding(.horizontal, Space.md)
      .padding(.vertical, Space.xs)
      .background(RoundedRectangle(cornerRadius: Radius.chip).fill(Palette.surface))
      .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Palette.border))
      .shadow(color: Palette.shadow.opacity(0.15), radius: 6)
      .alignmentGuide(.leading) { dimensions in
        -min(max(0, hover.x - dimensions.width / 2), max(0, width - dimensions.width))
      }
      .alignmentGuide(.top) { dimensions in dimensions.height + Space.sm }
      .allowsHitTesting(false)
  }
}
