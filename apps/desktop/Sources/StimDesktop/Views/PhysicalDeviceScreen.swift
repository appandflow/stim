import AppKit
import CoreVideo
import EmulatorFrames
import StimKit
import SwiftUI

/// A leased physical device's screen through Stim Desktop's stim-server connection. While `interactive`, an Android
/// phone takes clicks, trackpad scrolls and keys, and shows its Home, Back, Apps and Lock buttons.
struct PhysicalDeviceScreen: View {
  var device: DeviceRef
  var workspace: String
  var interactive: Bool
  var onPixelSizeChange: (CGSize) -> Void
  /// Control ended, or was refused, while `interactive`, other than by the user's Release.
  var onControlLost: () -> Void
  @ObservedObject private var session = ServerSession.shared
  @StateObject private var stream: PhysicalStream

  init(
    device: DeviceRef, workspace: String, interactive: Bool, onPixelSizeChange: @escaping (CGSize) -> Void,
    onControlLost: @escaping () -> Void
  ) {
    self.device = device
    self.workspace = workspace
    self.interactive = interactive
    self.onPixelSizeChange = onPixelSizeChange
    self.onControlLost = onControlLost
    _stream = StateObject(
      wrappedValue: PhysicalStream(
        target: ReplayTarget(workspace: workspace, platform: device.platform, slot: device.slot)))
  }

  var body: some View {
    TimelineView(.periodic(from: .now, by: 15)) { context in
      let screen = PhysicalScreen(device: device, link: session.link, now: context.date)
      content(screen)
        .onChange(of: screen, initial: true) { _, screen in follow(screen) }
    }
    .onChange(of: interactive, initial: true) { _, interactive in
      if interactive { stream.begin() } else { stream.end() }
    }
    .onChange(of: stream.control) { _, control in
      switch control {
      case .off, .failed: if interactive { onControlLost() }
      case .starting, .on: break
      }
    }
    .onDisappear { stream.stop() }
  }

  @ViewBuilder private func content(_ screen: PhysicalScreen) -> some View {
    switch screen {
    case .message(let text, let remedy):
      PhysicalMessage(text: text, remedy: remedy)
    case .stream:
      VStack(spacing: Space.md) {
        PhysicalDisplay(
          stream: stream, activityKey: device.activityKey, interactive: interactive && isControlling,
          onPixelSizeChange: onPixelSizeChange
        )
        .overlay {
          if let problem = stream.problem ?? (stream.receiving ? nil : "Connecting to the device") {
            PhysicalMessage(text: problem)
          }
        }
        if let controlNote {
          Text(controlNote).font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(2)
            .multilineTextAlignment(.center)
        }
        if interactive, device.platform == "android" { hardwareButtons }
      }
    }
  }

  private var isControlling: Bool {
    if case .on = stream.control { return true }
    return false
  }

  private var controlNote: String? {
    switch stream.control {
    case .starting: return "Taking over"
    case .failed(let message): return message
    case .off(ended: let ended?): return "Control ended. \(ended)"
    case .off, .on: return nil
    }
  }

  private var hardwareButtons: some View {
    HStack(spacing: Space.sm) {
      hardwareButton("Home", systemImage: "circle", button: "home")
      hardwareButton("Back", systemImage: "chevron.backward", button: "back")
      hardwareButton("Apps", systemImage: "square.on.square", button: "app-switch")
      hardwareButton("Lock", systemImage: "lock", button: "lock")
    }
    .disabled(!isControlling)
  }

  private func hardwareButton(_ title: String, systemImage: String, button: String) -> some View {
    Button(title, systemImage: systemImage) { stream.button(button) }
      .labelStyle(.iconOnly)
      .buttonStyle(.stim())
      .help("Press the phone's \(title) button")
      .accessibilityLabel("Press \(title)")
  }

  private func follow(_ screen: PhysicalScreen) {
    if case .stream = screen, session.isOpen {
      stream.connect(session.client)
      if interactive { stream.begin() }
    } else {
      stream.stop()
    }
  }
}

private struct PhysicalMessage: View {
  var text: String
  var remedy: String? = nil

  var body: some View {
    VStack(spacing: Space.sm) {
      Text(text)
        .font(.stim(.callout))
        .foregroundStyle(Palette.tertiary)
        .multilineTextAlignment(.center)
      if let remedy {
        Text(remedy)
          .font(.stim(.caption, mono: true))
          .foregroundStyle(Palette.secondary)
          .textSelection(.enabled)
      }
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Media.screen.opacity(0.85))
  }
}

private struct PhysicalDisplay: NSViewRepresentable {
  @ObservedObject var stream: PhysicalStream
  var activityKey: String?
  var interactive: Bool
  var onPixelSizeChange: (CGSize) -> Void

  func makeNSView(context: Context) -> PhysicalDisplayView {
    let view = PhysicalDisplayView()
    update(view)
    return view
  }

  func updateNSView(_ view: PhysicalDisplayView, context: Context) {
    update(view)
  }

  private func update(_ view: PhysicalDisplayView) {
    view.stream = stream
    view.activityKey = activityKey
    view.onPixelSizeChange = onPixelSizeChange
    view.setInteractive(interactive)
    stream.onVideo = { [weak view] packet in view?.show(packet) }
    stream.onImage = { [weak view] data in view?.show(jpeg: data) }
  }

  static func dismantleNSView(_ view: PhysicalDisplayView, coordinator: ()) {
    view.decoder.invalidate()
  }
}

final class PhysicalDisplayView: NSView {
  weak var stream: PhysicalStream?
  var activityKey: String?
  var onPixelSizeChange: (CGSize) -> Void = { _ in }
  private var size: CGSize?
  private var configured = false
  private var askedKeyframe = false
  private var interactive = false
  private var touching = false
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

  required init?(coder: NSCoder) { nil }

  @MainActor func show(_ packet: VideoPacket) {
    if packet.keyframe {
      configured = decoder.configure(packet.accessUnit)
      askedKeyframe = false
    }
    guard configured else {
      if !askedKeyframe {
        askedKeyframe = true
        stream?.requestKeyframe()
      }
      return
    }
    decoder.decode(packet.accessUnit)
    shown(CGSize(width: packet.width, height: packet.height))
  }

  @MainActor func show(jpeg: Data) {
    guard let image = NSImage(data: jpeg)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
    layer?.contents = image
    shown(CGSize(width: image.width, height: image.height))
  }

  private func shown(_ size: CGSize) {
    if let activityKey { ScreenActivity.shared.record(activityKey) }
    guard size != self.size else { return }
    self.size = size
    onPixelSizeChange(size)
  }

  func setInteractive(_ interactive: Bool) {
    guard interactive != self.interactive else { return }
    self.interactive = interactive
    if interactive {
      window?.makeFirstResponder(self)
    } else {
      touching = false
    }
  }

  private func point(_ event: NSEvent, clamped: Bool) -> CGPoint? {
    guard let size else { return nil }
    return normalizedScreenPoint(
      convert(event.locationInWindow, from: nil), viewSize: bounds.size, screenSize: size, clamped: clamped)
  }

  private func touch(_ phase: String, _ point: CGPoint) {
    stream?.touch(phase, x: point.x, y: point.y)
    touching = phase != "up"
    lastTouch = touching ? point : nil
  }

  private var lastTouch: CGPoint?

  override var acceptsFirstResponder: Bool { interactive }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { interactive }

  override func mouseDown(with event: NSEvent) {
    guard interactive else { return super.mouseDown(with: event) }
    window?.makeFirstResponder(self)
    guard !touching, let point = point(event, clamped: false) else { return }
    touch("down", point)
  }

  override func mouseDragged(with event: NSEvent) {
    guard touching, let point = point(event, clamped: true) else { return }
    touch("move", point)
  }

  override func mouseUp(with event: NSEvent) {
    guard touching, let last = lastTouch else { return }
    touch("up", point(event, clamped: true) ?? last)
  }

  // A trackpad scroll becomes a one-finger drag that follows the gesture's phases. Momentum events are dropped
  // because Android flings on its own after the finger lifts.
  override func scrollWheel(with event: NSEvent) {
    guard interactive, event.hasPreciseScrollingDeltas, event.momentumPhase.isEmpty else {
      return super.scrollWheel(with: event)
    }
    if event.phase.contains(.began) {
      guard !touching, let point = point(event, clamped: false) else { return }
      touch("down", point)
    } else if touching, let last = lastTouch, let size {
      let fitted = fittedScreenSize(viewSize: bounds.size, screenSize: size)
      guard fitted.width > 0, fitted.height > 0 else { return }
      let point = CGPoint(
        x: min(max(last.x + event.scrollingDeltaX / fitted.width, 0), 1),
        y: min(max(last.y + event.scrollingDeltaY / fitted.height, 0), 1))
      let ended = event.phase.contains(.ended) || event.phase.contains(.cancelled)
      touch(ended ? "up" : "move", point)
    }
  }

  override func keyDown(with event: NSEvent) {
    guard interactive, !event.modifierFlags.contains(.command), !event.modifierFlags.contains(.control),
      let text = physicalInputText(characters: event.characters, keyCode: event.keyCode)
    else { return super.keyDown(with: event) }
    stream?.text(text)
  }
}
