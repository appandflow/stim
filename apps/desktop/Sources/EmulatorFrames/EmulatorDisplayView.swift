import AppKit
import QuartzCore
import StimKit
import SwiftUI

public enum EmulatorStreamStatus: Equatable, Sendable {
  case connecting
  case noEndpoint
  case streaming
}

/// Live frames of a running emulator's main display, read through the gRPC
/// endpoint in its discovery file. When `interactive` is true, clicks, drags,
/// trackpad scrolls and keys go to the emulator over the same endpoint.
public struct EmulatorDisplayView: NSViewRepresentable {
  public var serial: String
  public var interactive: Bool
  public var onStatus: (EmulatorStreamStatus) -> Void

  public init(serial: String, interactive: Bool = false, onStatus: @escaping (EmulatorStreamStatus) -> Void) {
    self.serial = serial
    self.interactive = interactive
    self.onStatus = onStatus
  }

  public func makeNSView(context: Context) -> EmulatorDisplayNSView {
    let view = EmulatorDisplayNSView()
    view.onStatus = onStatus
    view.attach(serial: serial)
    view.setInteractive(interactive)
    return view
  }

  public func updateNSView(_ view: EmulatorDisplayNSView, context: Context) {
    view.onStatus = onStatus
    view.attach(serial: serial)
    view.setInteractive(interactive)
  }

  public static func dismantleNSView(_ view: EmulatorDisplayNSView, coordinator: ()) {
    view.detach()
  }
}

public final class EmulatorDisplayNSView: NSView {
  private static let maxPixels = 960

  var onStatus: ((EmulatorStreamStatus) -> Void)?
  private var serial: String?
  private var stream: ScreenshotStream?
  private var retryTimer: Timer?
  private var status: EmulatorStreamStatus?
  private var generation = 0
  private let pending = PendingFrame()
  private var endpoint: EmulatorEndpoint?
  private var shown: (size: CGSize, rotation: Int)?
  private var interactive = false
  private var input: EmulatorInput?
  private var displaySize: CGSize?
  private var touchPoint: CGPoint?
  private var keysDown: Set<UInt16> = []
  private var lastShown: CFTimeInterval = 0

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer = CALayer()
    layer?.contentsGravity = .resizeAspect
    layer?.minificationFilter = .trilinear
  }

  required init?(coder: NSCoder) { nil }

  func attach(serial: String) {
    guard serial != self.serial else { return }
    disconnect()
    self.serial = serial
    connect()
  }

  func detach() {
    disconnect()
    serial = nil
  }

  private func disconnect() {
    retryTimer?.invalidate()
    retryTimer = nil
    stream?.cancel()
    stream = nil
    _ = pending.take()
    layer?.contents = nil
    releaseInput()
    shown = nil
    endpoint = nil
  }

  private func connect() {
    guard let serial, window != nil, !framesPaused, stream == nil, retryTimer == nil else { return }
    guard let endpoint = EmulatorDiscovery.endpoint(serial: serial) else {
      report(.noEndpoint)
      retry()
      return
    }
    if endpoint != self.endpoint { releaseInput() }
    self.endpoint = endpoint
    report(.connecting)
    generation += 1
    let current = generation
    var framesSeen = 0
    let stream = ScreenshotStream(
      endpoint: endpoint, width: Self.maxPixels, height: Self.maxPixels,
      onFrame: { [weak self, pending] frame in
        framesSeen += 1
        if framesSeen > 1 { ScreenActivity.shared.record(serial) }
        guard pending.store(frame) else { return }
        DispatchQueue.main.async { self?.frameArrived(current) }
      },
      onEnd: { [weak self] in
        DispatchQueue.main.async {
          guard let self, self.stream != nil, self.generation == current else { return }
          self.stream = nil
          self.report(.connecting)
          self.retry()
        }
      })
    self.stream = stream
    stream.start()
  }

  private func retry() {
    retryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
      self?.retryTimer = nil
      self?.connect()
    }
  }

  private func frameArrived(_ generation: Int) {
    let wait = lastShown + 1 / AppPreferences.maxFramesPerSecond - CACurrentMediaTime()
    guard wait > 0 else {
      show(pending.take())
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
      guard let self, self.generation == generation else { return }
      self.show(self.pending.take())
    }
  }

  private var framesPaused: Bool {
    AppPreferences.pausesHiddenFrames && window?.occlusionState.contains(.visible) == false
  }

  private func show(_ frame: EmulatorFrame?) {
    guard stream != nil, let frame, let image = Self.image(frame) else { return }
    lastShown = CACurrentMediaTime()
    layer?.contents = image
    self.shown = (CGSize(width: frame.width, height: frame.height), frame.rotation)
    _ = inputClient()
    report(.streaming)
  }

  private func report(_ status: EmulatorStreamStatus) {
    guard status != self.status else { return }
    self.status = status
    onStatus?(status)
  }

  private static func image(_ frame: EmulatorFrame) -> CGImage? {
    guard let provider = CGDataProvider(data: frame.rgba as CFData) else { return nil }
    return CGImage(
      width: frame.width, height: frame.height, bitsPerComponent: 8, bitsPerPixel: 32,
      bytesPerRow: frame.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
      provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
  }

  public override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    NotificationCenter.default.removeObserver(self, name: NSWindow.didChangeOcclusionStateNotification, object: nil)
    if let window {
      NotificationCenter.default.addObserver(
        self, selector: #selector(occlusionChanged), name: NSWindow.didChangeOcclusionStateNotification, object: window)
      connect()
    } else {
      disconnect()
    }
  }

  @objc private func occlusionChanged() {
    if framesPaused {
      disconnect()
    } else {
      connect()
    }
  }

  func setInteractive(_ interactive: Bool) {
    guard interactive != self.interactive else { return }
    self.interactive = interactive
    if interactive {
      window?.makeFirstResponder(self)
    } else {
      releaseInput()
    }
  }

  private func releaseInput() {
    if let touchPoint, let input, let displaySize, let shown {
      let native = displayPixel(touchPoint, rotation: shown.rotation, displaySize: displaySize)
      input.call("sendMouse", InputMessages.mouse(x: native.x, y: native.y, pressed: false))
    }
    for code in keysDown { input?.call("sendKey", InputMessages.key(macKeyCode: code, down: false)) }
    touchPoint = nil
    keysDown = []
    input?.close()
    input = nil
    displaySize = nil
  }

  private func inputClient() -> EmulatorInput? {
    guard interactive, let endpoint, shown != nil else { return nil }
    if let input { return input }
    let input = EmulatorInput(endpoint: endpoint)
    self.input = input
    input.call("getStatus", Data()) { [weak self, weak input] response in
      let size = response.flatMap(InputMessages.displaySize(fromStatus:))
      DispatchQueue.main.async {
        guard let self, let size, input != nil, input === self.input else { return }
        self.displaySize = CGSize(width: size.width, height: size.height)
      }
    }
    return input
  }

  private func screenPoint(_ event: NSEvent, clamped: Bool) -> CGPoint? {
    guard let shown else { return nil }
    return normalizedScreenPoint(
      convert(event.locationInWindow, from: nil), viewSize: bounds.size, screenSize: shown.size, clamped: clamped)
  }

  private func mouse(at point: CGPoint, pressed: Bool) {
    guard let input = inputClient(), let displaySize, let shown else { return }
    let native = displayPixel(point, rotation: shown.rotation, displaySize: displaySize)
    input.call("sendMouse", InputMessages.mouse(x: native.x, y: native.y, pressed: pressed))
    touchPoint = pressed ? point : nil
  }

  public override var acceptsFirstResponder: Bool { interactive }

  public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { interactive }

  public override func mouseDown(with event: NSEvent) {
    guard interactive else { return super.mouseDown(with: event) }
    window?.makeFirstResponder(self)
    guard touchPoint == nil, let point = screenPoint(event, clamped: false) else { return }
    mouse(at: point, pressed: true)
  }

  public override func mouseDragged(with event: NSEvent) {
    guard touchPoint != nil, let point = screenPoint(event, clamped: true) else { return }
    mouse(at: point, pressed: true)
  }

  public override func mouseUp(with event: NSEvent) {
    guard let last = touchPoint else { return }
    mouse(at: screenPoint(event, clamped: true) ?? last, pressed: false)
  }

  // A trackpad scroll becomes a one-finger drag that follows the gesture's
  // phases, as on iOS. Momentum events are dropped because Android flings on
  // its own after the finger lifts.
  public override func scrollWheel(with event: NSEvent) {
    guard interactive, event.hasPreciseScrollingDeltas, event.momentumPhase.isEmpty else {
      return super.scrollWheel(with: event)
    }
    if event.phase.contains(.began) {
      guard touchPoint == nil, let point = screenPoint(event, clamped: false) else { return }
      mouse(at: point, pressed: true)
    } else if let last = touchPoint, let shown {
      let fitted = fittedScreenSize(viewSize: bounds.size, screenSize: shown.size)
      guard fitted.width > 0, fitted.height > 0 else { return }
      let point = CGPoint(
        x: min(max(last.x + event.scrollingDeltaX / fitted.width, 0), 1),
        y: min(max(last.y + event.scrollingDeltaY / fitted.height, 0), 1))
      let ended = event.phase.contains(.ended) || event.phase.contains(.cancelled)
      mouse(at: point, pressed: !ended)
    }
  }

  // Printable ASCII goes as text so the emulator picks the evdev keys and
  // Shift itself; other keys go as macOS key codes, which the emulator
  // translates. Command and Control shortcuts stay with the Mac.
  public override func keyDown(with event: NSEvent) {
    guard !event.modifierFlags.contains(.command), !event.modifierFlags.contains(.control),
      let input = inputClient()
    else { return super.keyDown(with: event) }
    if let text = event.characters, isPrintableASCII(text) {
      input.call("sendKey", InputMessages.text(text))
    } else if !event.isARepeat {
      keysDown.insert(event.keyCode)
      input.call("sendKey", InputMessages.key(macKeyCode: event.keyCode, down: true))
    }
  }

  public override func keyUp(with event: NSEvent) {
    guard keysDown.remove(event.keyCode) != nil, let input = inputClient() else { return super.keyUp(with: event) }
    input.call("sendKey", InputMessages.key(macKeyCode: event.keyCode, down: false))
  }
}

func isPrintableASCII(_ text: String) -> Bool {
  !text.isEmpty && text.unicodeScalars.allSatisfy { (32..<127).contains($0.value) }
}

/// Maps a fraction of the upright image, origin top-left, to a pixel of the
/// display in its native orientation, which is where the emulator places
/// touches. `rotation` is the image's Rotation.SkinRotation.
func displayPixel(_ point: CGPoint, rotation: Int, displaySize: CGSize) -> (x: Int, y: Int) {
  let native: CGPoint
  switch rotation {
  case 1: native = CGPoint(x: 1 - point.y, y: point.x)
  case 2: native = CGPoint(x: 1 - point.x, y: 1 - point.y)
  case 3: native = CGPoint(x: point.y, y: 1 - point.x)
  default: native = point
  }
  let x = Int((native.x * displaySize.width).rounded(.down))
  let y = Int((native.y * displaySize.height).rounded(.down))
  return (min(max(x, 0), Int(displaySize.width) - 1), min(max(y, 0), Int(displaySize.height) - 1))
}

private final class PendingFrame: @unchecked Sendable {
  private let lock = NSLock()
  private var frame: EmulatorFrame?

  func store(_ frame: EmulatorFrame) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    let wasEmpty = self.frame == nil
    self.frame = frame
    return wasEmpty
  }

  func take() -> EmulatorFrame? {
    lock.lock()
    defer { lock.unlock() }
    defer { frame = nil }
    return frame
  }
}
