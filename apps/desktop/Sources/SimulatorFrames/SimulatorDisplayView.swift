import AppKit
import QuartzCore
import StimKit
import SwiftUI

/// Live frames of one display of a booted iOS simulator, the main display
/// unless `screenID` names another, turned upright for the device's
/// orientation. When `interactive` is true, clicks, drags, trackpad scrolls
/// and keys go to the simulator. `onPixelSizeChange` receives the frame's
/// pixel size as displayed, after rotation.
public struct SimulatorDisplayView: NSViewRepresentable {
  public var udid: String
  public var screenID: UInt32
  public var interactive: Bool
  public var onPixelSizeChange: (CGSize) -> Void

  public init(
    udid: String, screenID: UInt32 = 1, interactive: Bool = false,
    onPixelSizeChange: @escaping (CGSize) -> Void = { _ in }
  ) {
    self.udid = udid
    self.screenID = screenID
    self.interactive = interactive
    self.onPixelSizeChange = onPixelSizeChange
  }

  public func makeNSView(context: Context) -> SimulatorDisplayNSView {
    let view = SimulatorDisplayNSView()
    view.onPixelSizeChange = onPixelSizeChange
    view.attach(udid: udid, screenID: screenID)
    view.setInteractive(interactive)
    return view
  }

  public func updateNSView(_ view: SimulatorDisplayNSView, context: Context) {
    view.onPixelSizeChange = onPixelSizeChange
    view.attach(udid: udid, screenID: screenID)
    view.setInteractive(interactive)
  }

  public static func dismantleNSView(_ view: SimulatorDisplayNSView, coordinator: ()) {
    view.detach()
  }
}

public final class SimulatorDisplayNSView: NSView {
  var onPixelSizeChange: (CGSize) -> Void = { _ in }
  private var udid: String?
  private var screenID: UInt32 = 1
  private var display: SimDisplay?
  private let callbackID = NSUUID()
  private var redrawPending = false
  private var retryTimer: Timer?
  private var interactive = false
  private var hid: SimulatorHID?
  private var touchPoint: CGPoint?
  private let surfaceLayer = CALayer()
  private var orientation: UInt32 = 1
  private var reportedSize: CGSize?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer = CALayer()
    surfaceLayer.contentsGravity = .resizeAspect
    surfaceLayer.minificationFilter = .trilinear
    layer?.addSublayer(surfaceLayer)
  }

  required init?(coder: NSCoder) { nil }

  func attach(udid: String, screenID: UInt32) {
    guard udid != self.udid || screenID != self.screenID else { return }
    disconnect()
    self.udid = udid
    self.screenID = screenID
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
      display.unregisterPropertiesCallback(callbackID)
    }
    display = nil
    surfaceLayer.contents = nil
    reportedSize = nil
    releaseInput()
  }

  private func connect() {
    guard let udid, display == nil, retryTimer == nil else { return }
    guard let display = CoreSimulator.displays(udid: udid).first(where: { $0.screenProperties?.screenID == screenID })
    else {
      retryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
        self?.retryTimer = nil
        self?.connect()
      }
      return
    }
    self.display = display
    showSurface()
    display.registerSurfacesCallback(callbackID) { [weak self] _ in
      DispatchQueue.main.async { self?.showSurface() }
    }
    display.registerDamageCallback(callbackID) { [weak self] _ in
      DispatchQueue.main.async { self?.scheduleRedraw() }
    }
    display.registerPropertiesCallback(callbackID) { [weak self] _ in
      DispatchQueue.main.async { self?.showSurface() }
    }
  }

  private func showSurface() {
    guard let display else { return }
    let surface = display.framebufferSurface
    surfaceLayer.contents = surface
    orientation = display.screenProperties?.uiOrientation ?? 1
    needsLayout = true
    guard let displayed = displayedScreenSize, displayed != reportedSize else { return }
    reportedSize = displayed
    // SwiftUI state must not change while it is updating this view.
    DispatchQueue.main.async { [weak self] in self?.onPixelSizeChange(displayed) }
  }

  private var isQuarterTurn: Bool { orientation == 3 || orientation == 4 }

  private var displayedScreenSize: CGSize? {
    guard let surface = display?.framebufferSurface else { return nil }
    return isQuarterTurn
      ? CGSize(width: surface.height, height: surface.width)
      : CGSize(width: surface.width, height: surface.height)
  }

  private var rotation: CGFloat {
    switch orientation {
    case 2: return .pi
    case 3: return -.pi / 2
    case 4: return .pi / 2
    default: return 0
    }
  }

  public override func layout() {
    super.layout()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    surfaceLayer.setAffineTransform(.identity)
    surfaceLayer.bounds = CGRect(
      origin: .zero,
      size: isQuarterTurn ? CGSize(width: bounds.height, height: bounds.width) : bounds.size)
    surfaceLayer.position = CGPoint(x: bounds.midX, y: bounds.midY)
    surfaceLayer.setAffineTransform(CGAffineTransform(rotationAngle: rotation))
    CATransaction.commit()
  }

  private var framesPaused: Bool {
    AppPreferences.pausesHiddenFrames && window?.occlusionState.contains(.visible) == false
  }

  private func scheduleRedraw() {
    guard !redrawPending, !framesPaused else { return }
    redrawPending = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / AppPreferences.maxFramesPerSecond) { [weak self] in
      guard let self else { return }
      self.redrawPending = false
      self.redraw()
    }
  }

  private func redraw() {
    // CALayer keeps drawing its cached copy of an IOSurface until told the
    // contents changed; the method is QuartzCore SPI, not public API.
    _ = surfaceLayer.perform(NSSelectorFromString("setContentsChanged"))
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
    if let touchPoint {
      hid?.touch(.up, at: nativeScreenPoint(touchPoint, orientation: orientation), screenID: screenID)
    }
    touchPoint = nil
    hid = nil
  }

  private func inputClient() -> SimulatorHID? {
    guard interactive, let udid, display != nil else { return nil }
    if hid == nil { hid = SimulatorHID(udid: udid) }
    return hid
  }

  private func screenPoint(_ event: NSEvent, clamped: Bool) -> CGPoint? {
    guard let screenSize = displayedScreenSize else { return nil }
    return normalizedScreenPoint(
      convert(event.locationInWindow, from: nil), viewSize: bounds.size, screenSize: screenSize, clamped: clamped)
  }

  private func touch(_ phase: TouchPhase, at point: CGPoint) {
    guard let hid = inputClient() else { return }
    hid.touch(phase, at: nativeScreenPoint(point, orientation: orientation), screenID: screenID)
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
    } else if let last = touchPoint, let screenSize = displayedScreenSize {
      let fitted = fittedScreenSize(viewSize: bounds.size, screenSize: screenSize)
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
    if !framesPaused { redraw() }
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

/// Maps a fraction of the upright screen, origin top-left, to a fraction of
/// the framebuffer in its native portrait orientation, which is what the
/// simulator's digitizer expects. `orientation` is a UIInterfaceOrientation.
func nativeScreenPoint(_ point: CGPoint, orientation: UInt32) -> CGPoint {
  switch orientation {
  case 2: return CGPoint(x: 1 - point.x, y: 1 - point.y)
  case 3: return CGPoint(x: point.y, y: 1 - point.x)
  case 4: return CGPoint(x: 1 - point.y, y: point.x)
  default: return point
  }
}
