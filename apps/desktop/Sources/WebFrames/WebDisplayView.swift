import AppKit
import ImageIO
import QuartzCore
import StimKit
import SwiftUI

public enum WebStreamStatus: Equatable, Sendable {
  case connecting
  case streaming
  case refused(String)
}

/// The owned Chrome page's screencast, read locally over its DevTools endpoint. When `interactive` is true, clicks,
/// drags, hover, scrolls and keys go to the page as DevTools input.
public struct WebDisplayView: NSViewRepresentable {
  public var endpoint: URL
  public var chromePid: Int32
  public var targetId: String
  public var interactive: Bool
  public var onStatus: (WebStreamStatus) -> Void
  public var onPixelSizeChange: (CGSize) -> Void

  public init(
    endpoint: URL, chromePid: Int32, targetId: String, interactive: Bool = false,
    onStatus: @escaping (WebStreamStatus) -> Void, onPixelSizeChange: @escaping (CGSize) -> Void = { _ in }
  ) {
    self.endpoint = endpoint
    self.chromePid = chromePid
    self.targetId = targetId
    self.interactive = interactive
    self.onStatus = onStatus
    self.onPixelSizeChange = onPixelSizeChange
  }

  public func makeNSView(context: Context) -> WebDisplayNSView {
    let view = WebDisplayNSView()
    updateNSView(view, context: context)
    return view
  }

  public func updateNSView(_ view: WebDisplayNSView, context: Context) {
    view.onStatus = onStatus
    view.onPixelSizeChange = onPixelSizeChange
    view.attach(WebDisplayNSView.Target(endpoint: endpoint, chromePid: chromePid, targetId: targetId))
    view.setInteractive(interactive)
  }

  public static func dismantleNSView(_ view: WebDisplayNSView, coordinator: ()) {
    view.detach()
  }
}

public final class WebDisplayNSView: NSView {
  struct Target: Equatable {
    var endpoint: URL
    var chromePid: Int32
    var targetId: String
  }

  private static let maxPixels = 1600

  var onStatus: ((WebStreamStatus) -> Void)?
  var onPixelSizeChange: (CGSize) -> Void = { _ in }
  private var target: Target?
  private var page: WebPage?
  private var generation = 0
  private var retryTimer: Timer?
  private var status: WebStreamStatus?
  private var shownSize: CGSize?
  private var cssWidth: CGFloat?
  private var interactive = false
  private var pressed = false
  private var lastShown: CFTimeInterval = 0
  private var pending: CGImage?
  private var tracking: NSTrackingArea?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer = CALayer()
    layer?.contentsGravity = .resizeAspect
    layer?.minificationFilter = .trilinear
  }

  required init?(coder: NSCoder) { nil }

  func attach(_ target: Target) {
    guard target != self.target else { return }
    disconnect()
    self.target = target
    connect()
  }

  func detach() {
    disconnect()
    target = nil
  }

  private func disconnect() {
    generation += 1
    retryTimer?.invalidate()
    retryTimer = nil
    page?.close()
    page = nil
    pending = nil
    pressed = false
    layer?.contents = nil
    shownSize = nil
  }

  private var framesPaused: Bool {
    AppPreferences.pausesHiddenFrames && window?.occlusionState.contains(.visible) == false
  }

  private func connect() {
    guard let target, window != nil, !framesPaused, page == nil, retryTimer == nil else { return }
    generation += 1
    let current = generation
    report(.connecting)
    WebPage.open(endpoint: target.endpoint, chromePid: target.chromePid, targetId: target.targetId) { [weak self] result in
      DispatchQueue.main.async {
        guard let self, self.generation == current else {
          if case .success(let page) = result { page.close() }
          return
        }
        switch result {
        case .failure(let failure):
          self.report(.refused(failure.description))
          self.retry()
        case .success(let page):
          self.page = page
          self.stream(page, generation: current)
        }
      }
    }
  }

  private func stream(_ page: WebPage, generation current: Int) {
    let key = target?.targetId
    var framesSeen = 0
    page.onFrame { [weak self] frame in
      framesSeen += 1
      if framesSeen > 1, let key { ScreenActivity.shared.record(key) }
      guard let source = CGImageSourceCreateWithData(frame.jpeg as CFData, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
      else { return }
      DispatchQueue.main.async {
        self?.cssWidth = frame.cssWidth
        self?.frameArrived(image, generation: current)
      }
    }
    page.onEnd { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, self.generation == current else { return }
        self.page = nil
        self.report(.connecting)
        self.retry()
      }
    }
    page.startScreencast(maxEdge: Self.maxPixels, quality: 80)
  }

  private func retry() {
    retryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
      self?.retryTimer = nil
      self?.connect()
    }
  }

  private func frameArrived(_ image: CGImage, generation current: Int) {
    guard generation == current else { return }
    let waiting = pending != nil
    pending = image
    guard !waiting else { return }
    let wait = lastShown + 1 / AppPreferences.maxFramesPerSecond - CACurrentMediaTime()
    DispatchQueue.main.asyncAfter(deadline: .now() + max(wait, 0)) { [weak self] in
      guard let self, self.generation == current, let image = self.pending else { return }
      self.pending = nil
      self.show(image)
    }
  }

  private func show(_ image: CGImage) {
    lastShown = CACurrentMediaTime()
    layer?.contents = image
    let size = CGSize(width: image.width, height: image.height)
    if size != shownSize { onPixelSizeChange(size) }
    shownSize = size
    report(.streaming)
  }

  private func report(_ status: WebStreamStatus) {
    guard status != self.status else { return }
    self.status = status
    onStatus?(status)
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
    if framesPaused { disconnect() } else { connect() }
  }

  func setInteractive(_ interactive: Bool) {
    guard interactive != self.interactive else { return }
    self.interactive = interactive
    if interactive {
      window?.makeFirstResponder(self)
    } else {
      releaseMouse()
    }
    updateTrackingAreas()
  }

  private func releaseMouse() {
    guard pressed else { return }
    pressed = false
    page?.mouse(.released, x: 0, y: 0, pressed: false)
  }

  public override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let tracking { removeTrackingArea(tracking) }
    tracking = nil
    guard interactive else { return }
    let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .activeInKeyWindow, .inVisibleRect], owner: self)
    addTrackingArea(area)
    tracking = area
  }

  private func point(_ event: NSEvent, clamped: Bool) -> CGPoint? {
    guard let shownSize else { return nil }
    return normalizedScreenPoint(
      convert(event.locationInWindow, from: nil), viewSize: bounds.size, screenSize: shownSize, clamped: clamped)
  }

  private func modifiers(_ event: NSEvent) -> WebModifiers {
    var modifiers: WebModifiers = []
    if event.modifierFlags.contains(.option) { modifiers.insert(.alt) }
    if event.modifierFlags.contains(.control) { modifiers.insert(.control) }
    if event.modifierFlags.contains(.command) { modifiers.insert(.meta) }
    if event.modifierFlags.contains(.shift) { modifiers.insert(.shift) }
    return modifiers
  }

  public override var acceptsFirstResponder: Bool { interactive }

  public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { interactive }

  public override func mouseDown(with event: NSEvent) {
    guard interactive, let page else { return super.mouseDown(with: event) }
    window?.makeFirstResponder(self)
    guard let at = point(event, clamped: false) else { return }
    pressed = true
    page.mouse(.pressed, x: at.x, y: at.y, pressed: true, clickCount: event.clickCount, modifiers: modifiers(event))
  }

  public override func mouseDragged(with event: NSEvent) {
    guard pressed, let page, let at = point(event, clamped: true) else { return }
    page.mouse(.moved, x: at.x, y: at.y, pressed: true, modifiers: modifiers(event))
  }

  public override func mouseUp(with event: NSEvent) {
    guard pressed, let page, let at = point(event, clamped: true) else { return }
    pressed = false
    page.mouse(.released, x: at.x, y: at.y, pressed: false, clickCount: event.clickCount, modifiers: modifiers(event))
  }

  public override func mouseMoved(with event: NSEvent) {
    guard interactive, !pressed, let page, let at = point(event, clamped: false) else { return }
    page.mouse(.moved, x: at.x, y: at.y, pressed: false, modifiers: modifiers(event))
  }

  public override func scrollWheel(with event: NSEvent) {
    guard interactive, let page, let at = point(event, clamped: false), let shownSize else {
      return super.scrollWheel(with: event)
    }
    let fitted = fittedScreenSize(viewSize: bounds.size, screenSize: shownSize)
    guard fitted.width > 0 else { return }
    let lines: CGFloat = event.hasPreciseScrollingDeltas ? 1 : 40
    let cssPerPoint = (cssWidth ?? shownSize.width) / fitted.width
    page.wheel(
      x: at.x, y: at.y, deltaX: -event.scrollingDeltaX * lines * cssPerPoint,
      deltaY: -event.scrollingDeltaY * lines * cssPerPoint, modifiers: modifiers(event))
  }

  public override func keyDown(with event: NSEvent) {
    guard interactive, let page, !event.modifierFlags.contains(.command) else { return super.keyDown(with: event) }
    if let key = Self.keys[event.keyCode] {
      page.press(key, modifiers: modifiers(event))
    } else if let text = event.characters, !text.isEmpty,
      text.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 && !(0xF700...0xF8FF).contains($0.value) }),
      !event.modifierFlags.contains(.control)
    {
      page.type(text)
    }
  }

  private static let keys: [UInt16: WebKey] = [
    0x24: .enter, 0x4C: .enter, 0x30: .tab, 0x33: .backspace, 0x75: .delete, 0x35: .escape, 0x7B: .left,
    0x7C: .right, 0x7D: .down, 0x7E: .up, 0x73: .home, 0x77: .end, 0x74: .pageUp, 0x79: .pageDown,
  ]
}
