import AppKit
import IOSurface
import QuartzCore
import StimKit
import SwiftUI

/// Live frames of one display of a booted iOS simulator, the main display
/// unless `screenID` names another, turned upright for the device's
/// orientation. When `interactive` is true, clicks, drags, trackpad scrolls
/// and keys go to the simulator. `onPixelSizeChange` receives the frame's
/// pixel size as displayed, after rotation. `onLitChange`, when set, receives
/// whether the display shows anything; the panel of an iPhone Duo that the
/// posture turned off is all black. `hingeAngle`, in degrees, projects the
/// active inner Duo display; callers leave it nil for cover or unknown panels.
public struct SimulatorDisplayView: NSViewRepresentable {
  public var udid: String
  public var screenID: UInt32
  public var interactive: Bool
  public var onPixelSizeChange: (CGSize) -> Void
  public var onLitChange: ((Bool) -> Void)?
  public var buttons: SimulatorButtons?
  public var hingeAngle: Double?
  public var showsDeviceFrame: Bool
  public var onFrameSizeChange: ((CGSize?) -> Void)?
  public var duoFrame: SimulatorDuoFrame?
  public var activeScreenID: UInt32?
  public var duoHingeAngle: Double?
  public var artworkScale: CGFloat?
  public var accurateScreenSize: CGSize?

  public init(
    udid: String, screenID: UInt32 = 1, interactive: Bool = false,
    onPixelSizeChange: @escaping (CGSize) -> Void = { _ in }, onLitChange: ((Bool) -> Void)? = nil,
    buttons: SimulatorButtons? = nil, hingeAngle: Double? = nil, showsDeviceFrame: Bool = false,
    onFrameSizeChange: ((CGSize?) -> Void)? = nil, duoFrame: SimulatorDuoFrame? = nil, activeScreenID: UInt32? = nil,
    duoHingeAngle: Double? = nil, artworkScale: CGFloat? = nil, accurateScreenSize: CGSize? = nil
  ) {
    self.udid = udid
    self.screenID = screenID
    self.interactive = interactive
    self.onPixelSizeChange = onPixelSizeChange
    self.onLitChange = onLitChange
    self.buttons = buttons
    self.hingeAngle = hingeAngle
    self.showsDeviceFrame = showsDeviceFrame
    self.onFrameSizeChange = onFrameSizeChange
    self.duoFrame = duoFrame
    self.activeScreenID = activeScreenID
    self.duoHingeAngle = duoHingeAngle
    self.artworkScale = artworkScale
    self.accurateScreenSize = accurateScreenSize
  }

  public final class Coordinator {
    var identity: String?
  }

  public func makeCoordinator() -> Coordinator { Coordinator() }

  public func makeNSView(context: Context) -> DeviceFrameNSView {
    let view = SimulatorDisplayNSView()
    let canvas = DeviceFrameNSView(screen: view)
    canvas.onFrameSizeChange = onFrameSizeChange ?? { _ in }
    let frameIdentity = showsDeviceFrame || onFrameSizeChange != nil ? udid : nil
    context.coordinator.identity = frameIdentity
    canvas.artwork = frameIdentity == nil ? nil : SimulatorFrameArtwork.load(udid: udid)
    canvas.showsFrame = showsDeviceFrame
    canvas.artworkScale = artworkScale
    canvas.accurateScreenSize = accurateScreenSize
    view.onOrientationChange = { [weak canvas] orientation in
      canvas?.quarterTurns = orientation == 3 ? 1 : orientation == 4 ? 3 : orientation == 2 ? 2 : 0
    }
    view.onPixelSizeChange = onPixelSizeChange
    view.onLitChange = onLitChange
    view.attach(udid: udid, screenID: screenID)
    view.setInteractive(interactive)
    view.hingeAngle = hingeAngle
    duoFrame?.attach(
      view, udid: udid, screenID: screenID, activeID: activeScreenID,
      angle: duoHingeAngle, shown: showsDeviceFrame, onFrameSize: onFrameSizeChange ?? { _ in })
    buttons?.view = view
    return canvas
  }

  public func updateNSView(_ canvas: DeviceFrameNSView, context: Context) {
    guard let view = canvas.screen as? SimulatorDisplayNSView else { return }
    canvas.onFrameSizeChange = onFrameSizeChange ?? { _ in }
    let frameIdentity = showsDeviceFrame || onFrameSizeChange != nil ? udid : nil
    if context.coordinator.identity != frameIdentity {
      context.coordinator.identity = frameIdentity
      canvas.artwork = frameIdentity == nil ? nil : SimulatorFrameArtwork.load(udid: udid)
    }
    canvas.showsFrame = showsDeviceFrame
    canvas.artworkScale = artworkScale
    canvas.accurateScreenSize = accurateScreenSize
    view.onPixelSizeChange = onPixelSizeChange
    view.onLitChange = onLitChange
    view.attach(udid: udid, screenID: screenID)
    view.setInteractive(interactive)
    view.hingeAngle = hingeAngle
    duoFrame?.attach(
      view, udid: udid, screenID: screenID, activeID: activeScreenID,
      angle: duoHingeAngle, shown: showsDeviceFrame, onFrameSize: onFrameSizeChange ?? { _ in })
    buttons?.view = view
  }

  public static func dismantleNSView(_ canvas: DeviceFrameNSView, coordinator: Coordinator) {
    (canvas.screen as? SimulatorDisplayNSView)?.detach()
  }
}

/// Presses a simulator's hardware buttons through the input client of the display view it is attached to, which
/// accepts them only while that view is interactive.
@MainActor
public final class SimulatorButtons {
  weak var view: SimulatorDisplayNSView?

  public init() {}

  public func press(_ button: SimulatorButton) {
    view?.press(button)
  }
}

public final class SimulatorDisplayNSView: NSView {
  var onPixelSizeChange: (CGSize) -> Void = { _ in }
  var onOrientationChange: (UInt32) -> Void = { _ in }
  var onLitChange: ((Bool) -> Void)? {
    didSet {
      watchLit()
      if oldValue == nil, onLitChange != nil { reportLit() }
    }
  }
  private var reportedLit: Bool?
  private var litTimer: Timer?
  private var udid: String?
  private var screenID: UInt32 = 1
  private var display: SimDisplay?
  private let callbackID = NSUUID()
  private var redrawPending = false
  private var retryTimer: Timer?
  private var interactive = false
  private var hid: SimulatorHID?
  private var touchPoint: CGPoint?
  private var keyboardModifiers = SimulatorKeyboardModifiers()
  private lazy var twoFinger = TwoFingerGesture(
    view: self, enabled: { [weak self] in self?.interactive == true },
    map: { [weak self] point, clamped in self?.screenPoint(point, clamped: clamped) },
    project: { [weak self] point in self?.viewPoint(point) },
    send: { [weak self] phase, first, second in
      guard let self else { return false }
      if phase == .move, self.hid?.isConnected != true {
        self.releaseInput()
        return false
      }
      guard let hid = phase == .up ? self.hid : self.inputClient() else { return false }
      let touchPhase: TouchPhase = phase == .down ? .down : phase == .move ? .move : .up
      hid.touch(
        touchPhase, at: nativeScreenPoint(first, orientation: self.orientation),
        second: nativeScreenPoint(second, orientation: self.orientation), screenID: self.screenID)
      return true
    })
  private let surfaceLayer = CALayer()
  private let foldedScreen = DuoFoldRenderer()
  private var surface: IOSurface?
  var onSurfaceChange: ((IOSurface?, UInt32) -> Void)? {
    didSet { onSurfaceChange?(surface, orientation) }
  }
  var duoModel: DuoModelView? {
    didSet {
      guard oldValue !== duoModel else { return }
      oldValue?.removeFromSuperview()
      if let duoModel { addSubview(duoModel) }
      needsLayout = true
    }
  }
  var hingeAngle: Double? {
    didSet { needsLayout = true }
  }
  private var foldProjection: DuoFoldProjection? {
    guard let hingeAngle, hingeAngle < 180, let axis = DuoFoldProjection.axis(orientation: orientation),
      let size = displayedScreenSize
    else { return nil }
    return DuoFoldProjection(size: size, angle: hingeAngle, axis: axis)
  }
  private var orientation: UInt32 = 1
  private var reportedSize: CGSize?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer = CALayer()
    surfaceLayer.contentsGravity = .resizeAspect
    surfaceLayer.minificationFilter = .trilinear
    layer?.addSublayer(surfaceLayer)
    layer?.addSublayer(foldedScreen.layer)
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
    surface = nil
    onSurfaceChange?(nil, orientation)
    surfaceLayer.contents = nil
    foldedScreen.show(nil)
    reportedSize = nil
    reportedLit = nil
    litTimer?.invalidate()
    litTimer = nil
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
      ScreenActivity.shared.record(udid)
      DispatchQueue.main.async { self?.scheduleRedraw() }
    }
    display.registerPropertiesCallback(callbackID) { [weak self] _ in
      DispatchQueue.main.async { self?.showSurface() }
    }
    watchLit()
  }

  private func showSurface() {
    guard let display else { return }
    showSurface(display.framebufferSurface, orientation: display.screenProperties?.uiOrientation ?? 1)
  }

  func showSurface(_ surface: IOSurface?, orientation: UInt32) {
    if orientation != self.orientation { releaseInput() }
    self.surface = surface
    surfaceLayer.contents = surface
    foldedScreen.show(surface)
    self.orientation = orientation
    onOrientationChange(orientation)
    onSurfaceChange?(surface, orientation)
    needsLayout = true
    reportLit()
    guard let displayed = displayedScreenSize, displayed != reportedSize else { return }
    reportedSize = displayed
    // SwiftUI state must not change while it is updating this view.
    DispatchQueue.main.async { [weak self] in self?.onPixelSizeChange(displayed) }
  }

  private var isQuarterTurn: Bool { orientation == 3 || orientation == 4 }

  private var displayedScreenSize: CGSize? {
    guard let surface else { return nil }
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
    let projection = foldProjection
    surfaceLayer.isHidden = duoModel != nil || projection != nil
    foldedScreen.layer.isHidden = duoModel != nil || projection == nil
    duoModel?.frame = bounds
    if let projection { foldedScreen.layout(projection, in: bounds, orientation: orientation) }
    CATransaction.commit()
    twoFinger.redraw()
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
    foldedScreen.redraw()
    onSurfaceChange?(surface, orientation)
    reportLit()
  }

  // CoreSimulator sends no damage for a panel the posture turns off, so the lit check also runs on a timer.
  private func watchLit() {
    guard onLitChange != nil, display != nil, litTimer == nil else { return }
    litTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.reportLit() }
  }

  private func reportLit() {
    guard onLitChange != nil, let surface else { return }
    let lit = !isBlack(surface)
    guard lit != reportedLit else { return }
    reportedLit = lit
    DispatchQueue.main.async { [weak self] in self?.onLitChange?(lit) }
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

  func releaseInput() {
    twoFinger.cancel()
    if let touchPoint {
      hid?.touch(.up, at: nativeScreenPoint(touchPoint, orientation: orientation), screenID: screenID)
    }
    touchPoint = nil
    for code in keyboardModifiers.release() { hid?.hardwareKey(code: code, down: false) }
    hid = nil
  }

  private func inputClient() -> SimulatorHID? {
    guard interactive, let udid, display != nil else { return nil }
    if hid?.isConnected != true { hid = SimulatorHID(udid: udid) }
    return hid
  }

  func press(_ button: SimulatorButton) {
    guard let hid = inputClient() else { return }
    hid.button(button, down: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { hid.button(button, down: false) }
  }

  private func screenPoint(_ event: NSEvent, clamped: Bool) -> CGPoint? {
    screenPoint(convert(event.locationInWindow, from: nil), clamped: clamped)
  }

  func screenPoint(_ point: CGPoint, clamped: Bool) -> CGPoint? {
    guard let screenSize = displayedScreenSize else { return nil }
    if let duoModel {
      guard let native = duoModel.nativeScreenPoint(point, clamped: clamped) else { return nil }
      return nativeScreenPoint(native, orientation: orientation == 3 ? 4 : orientation == 4 ? 3 : orientation)
    }
    if let projection = foldProjection { return projection.screenPoint(point, in: bounds, clamped: clamped) }
    return normalizedScreenPoint(point, viewSize: bounds.size, screenSize: screenSize, clamped: clamped)
  }

  private func viewPoint(_ point: CGPoint) -> CGPoint? {
    guard let size = displayedScreenSize else { return nil }
    if let duoModel { return duoModel.viewPoint(nativeScreenPoint(point, orientation: orientation)) }
    if let projection = foldProjection {
      return projection.viewPoint(CGPoint(x: point.x * size.width, y: (1 - point.y) * size.height), in: bounds)
    }
    let fitted = fittedScreenSize(viewSize: bounds.size, screenSize: size)
    return CGPoint(
      x: (bounds.width - fitted.width) / 2 + point.x * fitted.width,
      y: (bounds.height - fitted.height) / 2 + (1 - point.y) * fitted.height)
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
    guard touchPoint == nil, !twoFinger.isActive else { return }
    if twoFinger.mouseDown(event) { return }
    guard !event.modifierFlags.contains(.option), let point = screenPoint(event, clamped: false) else { return }
    touch(.down, at: point)
  }

  public override func mouseDragged(with event: NSEvent) {
    if twoFinger.mouseDragged(event) { return }
    guard touchPoint != nil, let point = screenPoint(event, clamped: true) else { return }
    touch(.move, at: point)
  }

  public override func mouseUp(with event: NSEvent) {
    if twoFinger.mouseUp(event) { return }
    guard let last = touchPoint else { return }
    touch(.up, at: screenPoint(event, clamped: true) ?? last)
  }

  // iOS has no scroll wheel, so a trackpad scroll becomes a one-finger drag
  // that follows the gesture's phases. Momentum events are dropped because iOS
  // applies its own deceleration after the finger lifts.
  public override func scrollWheel(with event: NSEvent) {
    if twoFinger.isActive { return }
    if interactive, event.hasPreciseScrollingDeltas, !event.momentumPhase.isEmpty { return }
    guard interactive, event.hasPreciseScrollingDeltas else {
      return super.scrollWheel(with: event)
    }
    if event.phase.contains(.began) {
      guard touchPoint == nil, let point = screenPoint(event, clamped: false) else { return }
      touch(.down, at: point)
    } else if let last = touchPoint, let screenSize = displayedScreenSize {
      let point: CGPoint
      if let duoModel {
        guard let location = duoModel.viewPoint(nativeScreenPoint(last, orientation: orientation)),
          let native = duoModel.nativeScreenPoint(
            CGPoint(
              x: location.x + event.scrollingDeltaX,
              y: location.y - event.scrollingDeltaY), clamped: true)
        else { return }
        point = nativeScreenPoint(native, orientation: orientation == 3 ? 4 : orientation == 4 ? 3 : orientation)
      } else if let projection = foldProjection {
        let location = projection.viewPoint(
          CGPoint(
            x: last.x * screenSize.width,
            y: (1 - last.y) * screenSize.height), in: bounds)
        guard
          let projected = projection.screenPoint(
            CGPoint(
              x: location.x + event.scrollingDeltaX,
              y: location.y - event.scrollingDeltaY), in: bounds, clamped: true)
        else { return }
        point = projected
      } else {
        let fitted = fittedScreenSize(viewSize: bounds.size, screenSize: screenSize)
        guard fitted.width > 0, fitted.height > 0 else { return }
        point = CGPoint(
          x: min(max(last.x + event.scrollingDeltaX / fitted.width, 0), 1),
          y: min(max(last.y + event.scrollingDeltaY / fitted.height, 0), 1))
      }
      let ended = event.phase.contains(.ended) || event.phase.contains(.cancelled)
      touch(ended ? .up : .move, at: point)
    }
  }

  public override func magnify(with event: NSEvent) {
    guard touchPoint == nil else { return }
    twoFinger.magnify(event)
  }

  public override func keyDown(with event: NSEvent) {
    guard !event.modifierFlags.contains(.option), let hid = inputClient() else { return super.keyDown(with: event) }
    if !event.isARepeat { hid.hardwareKey(code: event.keyCode, down: true) }
  }

  public override func keyUp(with event: NSEvent) {
    guard let hid = inputClient() else { return super.keyUp(with: event) }
    hid.hardwareKey(code: event.keyCode, down: false)
  }

  public override func flagsChanged(with event: NSEvent) {
    twoFinger.flagsChanged(event)
    guard let hid = inputClient() else { return super.flagsChanged(with: event) }
    for key in keyboardModifiers.change(keyCode: event.keyCode, flags: event.modifierFlags) {
      hid.hardwareKey(code: key.code, down: key.down)
    }
  }

  public override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    NotificationCenter.default.removeObserver(self, name: NSWindow.didChangeOcclusionStateNotification, object: nil)
    NotificationCenter.default.removeObserver(self, name: NSWindow.didResignKeyNotification, object: nil)
    if let window {
      NotificationCenter.default.addObserver(
        self, selector: #selector(occlusionChanged), name: NSWindow.didChangeOcclusionStateNotification, object: window)
      NotificationCenter.default.addObserver(
        self, selector: #selector(windowResignedKey), name: NSWindow.didResignKeyNotification, object: window)
      connect()
    } else {
      disconnect()
    }
  }

  @objc private func windowResignedKey() { twoFinger.cancel() }

  @objc private func occlusionChanged() {
    if !framesPaused { redraw() }
  }
}
