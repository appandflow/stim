import AppKit
import QuartzCore
import SwiftUI

/// Live frames of a booted iOS simulator's main display. When `interactive`
/// is true, clicks, drags, trackpad scrolls and keys go to the simulator.
public struct SimulatorDisplayView: NSViewRepresentable {
  public var udid: String
  public var interactive: Bool

  public init(udid: String, interactive: Bool = false) {
    self.udid = udid
    self.interactive = interactive
  }

  public func makeNSView(context: Context) -> SimulatorDisplayNSView {
    let view = SimulatorDisplayNSView()
    view.attach(udid: udid)
    view.setInteractive(interactive)
    return view
  }

  public func updateNSView(_ view: SimulatorDisplayNSView, context: Context) {
    view.attach(udid: udid)
    view.setInteractive(interactive)
  }

  public static func dismantleNSView(_ view: SimulatorDisplayNSView, coordinator: ()) {
    view.detach()
  }
}

public final class SimulatorDisplayNSView: NSView {
  private var udid: String?
  private var display: SimDisplayIOSurfaceRenderable?
  private let callbackID = NSUUID()
  private var redrawPending = false
  private var retryTimer: Timer?
  private var interactive = false
  private var hid: SimulatorHID?
  private var touchPoint: CGPoint?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer = CALayer()
    layer?.contentsGravity = .resizeAspect
    layer?.minificationFilter = .trilinear
  }

  required init?(coder: NSCoder) { nil }

  func attach(udid: String) {
    guard udid != self.udid else { return }
    disconnect()
    self.udid = udid
    connect()
  }

  func detach() {
    disconnect()
    udid = nil
  }

  private func disconnect() {
    retryTimer?.invalidate()
    retryTimer = nil
    if let display {
      display.unregisterDamageCallback(callbackID)
      display.unregisterSurfacesCallback(callbackID)
    }
    display = nil
    layer?.contents = nil
    releaseInput()
  }

  private func connect() {
    guard let udid, display == nil, retryTimer == nil else { return }
    guard let display = CoreSimulator.mainDisplay(udid: udid) else {
      retryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
        self?.retryTimer = nil
        self?.connect()
      }
      return
    }
    self.display = display
    layer?.contents = display.framebufferSurface
    display.registerSurfacesCallback(callbackID) { [weak self] _ in
      DispatchQueue.main.async { self?.layer?.contents = display.framebufferSurface }
    }
    display.registerDamageCallback(callbackID) { [weak self] _ in
      DispatchQueue.main.async { self?.scheduleRedraw() }
    }
  }

  private func scheduleRedraw() {
    guard !redrawPending else { return }
    redrawPending = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 60) { [weak self] in
      guard let self else { return }
      self.redrawPending = false
      // CALayer keeps drawing its cached copy of an IOSurface until told the
      // contents changed; the method is QuartzCore SPI, not public API.
      _ = self.layer?.perform(NSSelectorFromString("setContentsChanged"))
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
    if let touchPoint { hid?.touch(.up, at: touchPoint) }
    touchPoint = nil
    hid = nil
  }

  private func inputClient() -> SimulatorHID? {
    guard interactive, let udid, display != nil else { return nil }
    if hid == nil { hid = SimulatorHID(udid: udid) }
    return hid
  }

  private func screenPoint(_ event: NSEvent, clamped: Bool) -> CGPoint? {
    guard let surface = display?.framebufferSurface else { return nil }
    return normalizedScreenPoint(
      convert(event.locationInWindow, from: nil), viewSize: bounds.size,
      screenSize: CGSize(width: surface.width, height: surface.height), clamped: clamped)
  }

  private func touch(_ phase: TouchPhase, at point: CGPoint) {
    guard let hid = inputClient() else { return }
    hid.touch(phase, at: point)
    touchPoint = phase == .up ? nil : point
  }

  public override var acceptsFirstResponder: Bool { interactive }

  public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { interactive }

  public override func mouseDown(with event: NSEvent) {
    guard interactive else { return super.mouseDown(with: event) }
    window?.makeFirstResponder(self)
    guard touchPoint == nil, let point = screenPoint(event, clamped: false) else { return }
    touch(.down, at: point)
  }

  public override func mouseDragged(with event: NSEvent) {
    guard touchPoint != nil, let point = screenPoint(event, clamped: true) else { return }
    touch(.move, at: point)
  }

  public override func mouseUp(with event: NSEvent) {
    guard let last = touchPoint else { return }
    touch(.up, at: screenPoint(event, clamped: true) ?? last)
  }

  // iOS has no scroll wheel, so a trackpad scroll becomes a one-finger drag
  // that follows the gesture's phases. Momentum events are dropped because iOS
  // applies its own deceleration after the finger lifts.
  public override func scrollWheel(with event: NSEvent) {
    guard interactive, event.hasPreciseScrollingDeltas, event.momentumPhase.isEmpty else {
      return super.scrollWheel(with: event)
    }
    if event.phase.contains(.began) {
      guard touchPoint == nil, let point = screenPoint(event, clamped: false) else { return }
      touch(.down, at: point)
    } else if let last = touchPoint, let surface = display?.framebufferSurface {
      let fitted = fittedScreenSize(
        viewSize: bounds.size, screenSize: CGSize(width: surface.width, height: surface.height))
      guard fitted.width > 0, fitted.height > 0 else { return }
      let point = CGPoint(
        x: min(max(last.x + event.scrollingDeltaX / fitted.width, 0), 1),
        y: min(max(last.y + event.scrollingDeltaY / fitted.height, 0), 1))
      let ended = event.phase.contains(.ended) || event.phase.contains(.cancelled)
      touch(ended ? .up : .move, at: point)
    }
  }

  public override func keyDown(with event: NSEvent) {
    guard let hid = inputClient() else { return super.keyDown(with: event) }
    if !event.isARepeat { hid.key(code: event.keyCode, down: true) }
  }

  public override func keyUp(with event: NSEvent) {
    guard let hid = inputClient() else { return super.keyUp(with: event) }
    hid.key(code: event.keyCode, down: false)
  }

  public override func flagsChanged(with event: NSEvent) {
    guard let hid = inputClient(), let flag = modifierFlag(keyCode: event.keyCode) else {
      return super.flagsChanged(with: event)
    }
    hid.key(code: event.keyCode, down: event.modifierFlags.contains(flag))
  }

  public override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window == nil { disconnect() } else { connect() }
  }
}

private func modifierFlag(keyCode: UInt16) -> NSEvent.ModifierFlags? {
  switch keyCode {
  case 56, 60: return .shift
  case 59, 62: return .control
  case 58, 61: return .option
  case 55, 54: return .command
  case 57: return .capsLock
  default: return nil
  }
}

func fittedScreenSize(viewSize: CGSize, screenSize: CGSize) -> CGSize {
  guard screenSize.width > 0, screenSize.height > 0 else { return .zero }
  let scale = min(viewSize.width / screenSize.width, viewSize.height / screenSize.height)
  return CGSize(width: screenSize.width * scale, height: screenSize.height * scale)
}

/// Maps a point in an unflipped view that shows the screen aspect-fit and
/// centered to a fraction of the screen with a top-left origin. Returns nil
/// for a point in the letterbox unless `clamped` is true.
func normalizedScreenPoint(_ point: CGPoint, viewSize: CGSize, screenSize: CGSize, clamped: Bool) -> CGPoint? {
  let fitted = fittedScreenSize(viewSize: viewSize, screenSize: screenSize)
  guard fitted.width > 0, fitted.height > 0 else { return nil }
  let x = (point.x - (viewSize.width - fitted.width) / 2) / fitted.width
  let y = 1 - (point.y - (viewSize.height - fitted.height) / 2) / fitted.height
  if clamped { return CGPoint(x: min(max(x, 0), 1), y: min(max(y, 0), 1)) }
  guard (0...1).contains(x), (0...1).contains(y) else { return nil }
  return CGPoint(x: x, y: y)
}
