import AppKit

// Adapted from Siniulator's Multitouch.swift, MIT licensed; see Support/Siniulator-LICENSE.txt.
public struct TwoFingerPositions {
  public private(set) var center = CGPoint(x: 0.5, y: 0.5)
  public private(set) var first = CGPoint(x: 0.35, y: 0.5)
  private var previous: CGPoint?
  private var translating = false
  private var offset = CGPoint.zero

  public init() {}

  public var second: CGPoint { CGPoint(x: 2 * center.x - first.x, y: 2 * center.y - first.y) }

  public mutating func resetTracking() {
    previous = nil
    translating = false
    offset = .zero
  }

  public mutating func update(pointer: CGPoint, translating: Bool) {
    if previous != nil, self.translating != translating {
      offset = CGPoint(x: first.x - pointer.x, y: first.y - pointer.y)
    } else if translating, let previous {
      let other = second
      let dx = min(1 - max(first.x, other.x), max(-min(first.x, other.x), pointer.x - previous.x))
      let dy = min(1 - max(first.y, other.y), max(-min(first.y, other.y), pointer.y - previous.y))
      center.x += dx
      center.y += dy
      first.x += dx
      first.y += dy
    } else {
      first = CGPoint(
        x: min(min(1, 2 * center.x), max(max(0, 2 * center.x - 1), pointer.x + offset.x)),
        y: min(min(1, 2 * center.y), max(max(0, 2 * center.y - 1), pointer.y + offset.y)))
    }
    previous = pointer
    self.translating = translating
  }
}

public enum TwoFingerPhase { case down, move, up }

@MainActor
public final class TwoFingerGesture: NSObject {
  private weak var view: NSView?
  private let map: (CGPoint, Bool) -> CGPoint?
  private let project: (CGPoint) -> CGPoint?
  private let send: (TwoFingerPhase, CGPoint, CGPoint) -> Bool
  private let enabled: () -> Bool
  private var positions = TwoFingerPositions()
  private var contacts: (CGPoint, CGPoint)?
  private var pinching = false
  private var pinchDistance: CGFloat = 0.15
  private var showing = false
  private let markers = [CAShapeLayer(), CAShapeLayer()]

  public var isActive: Bool { contacts != nil }

  public init(
    view: NSView, enabled: @escaping () -> Bool,
    map: @escaping (CGPoint, Bool) -> CGPoint?, project: @escaping (CGPoint) -> CGPoint?,
    send: @escaping (TwoFingerPhase, CGPoint, CGPoint) -> Bool
  ) {
    self.view = view
    self.enabled = enabled
    self.map = map
    self.project = project
    self.send = send
    super.init()
    for marker in markers {
      marker.fillColor = NSColor.white.withAlphaComponent(0.35).cgColor
      marker.strokeColor = NSColor.white.cgColor
      marker.lineWidth = 2
      marker.zPosition = 10000
      marker.isHidden = true
      view.layer?.addSublayer(marker)
    }
    view.addTrackingArea(
      NSTrackingArea(
        rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
        owner: self, userInfo: nil))
  }

  public func mouseDown(_ event: NSEvent) -> Bool {
    guard enabled(), event.modifierFlags.contains(.option), !isActive,
      let pointer = point(event, clamped: false)
    else { return false }
    positions.update(pointer: pointer, translating: event.modifierFlags.contains(.shift))
    guard send(.down, positions.first, positions.second) else { return false }
    contacts = (positions.first, positions.second)
    showing = true
    redraw()
    return true
  }

  public func mouseDragged(_ event: NSEvent) -> Bool {
    guard isActive, !pinching else { return false }
    update(event)
    return true
  }

  public func mouseUp(_ event: NSEvent) -> Bool {
    guard isActive, !pinching else { return false }
    update(event)
    end()
    return true
  }

  public func magnify(_ event: NSEvent) {
    guard enabled() else { return }
    if !isActive {
      guard event.phase != .ended, event.phase != .cancelled, point(event, clamped: false) != nil else { return }
      pinchDistance = 0.15
      let first = CGPoint(x: 0.5 - pinchDistance, y: 0.5)
      let second = CGPoint(x: 0.5 + pinchDistance, y: 0.5)
      guard send(.down, first, second) else { return }
      contacts = (first, second)
      pinching = true
    }
    guard pinching else { return }
    pinchDistance = min(0.45, max(0.02, pinchDistance + event.magnification * 0.3))
    let first = CGPoint(x: 0.5 - pinchDistance, y: 0.5)
    let second = CGPoint(x: 0.5 + pinchDistance, y: 0.5)
    if send(.move, first, second) { contacts = (first, second) }
    showing = true
    redraw()
    if event.phase == .ended || event.phase == .cancelled {
      end()
      hide()
    }
  }

  public func flagsChanged(_ event: NSEvent) {
    guard enabled(), event.modifierFlags.contains(.option) else {
      if !pinching { end() }
      hide()
      return
    }
    showing = true
    update(event)
  }

  public func cancel() {
    end()
    hide()
  }

  private func end() {
    if let contacts { _ = send(.up, contacts.0, contacts.1) }
    contacts = nil
    pinching = false
  }

  private func hide() {
    showing = false
    positions.resetTracking()
    redraw()
  }

  private func point(_ event: NSEvent, clamped: Bool) -> CGPoint? {
    guard let view else { return nil }
    let location =
      event.type == .flagsChanged
      ? view.window?.mouseLocationOutsideOfEventStream ?? event.locationInWindow : event.locationInWindow
    return map(view.convert(location, from: nil), clamped)
  }

  private func update(_ event: NSEvent) {
    guard enabled() else {
      cancel()
      return
    }
    guard let pointer = point(event, clamped: isActive) else { return }
    positions.update(pointer: pointer, translating: event.modifierFlags.contains(.shift))
    if isActive, !pinching, send(.move, positions.first, positions.second) {
      contacts = (positions.first, positions.second)
    }
    redraw()
  }

  public func redraw() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let pair = contacts ?? (positions.first, positions.second)
    for (marker, point) in zip(markers, [pair.0, pair.1]) {
      guard showing, enabled(), let local = project(point) else {
        marker.isHidden = true
        continue
      }
      marker.path = CGPath(ellipseIn: CGRect(x: local.x - 12, y: local.y - 12, width: 24, height: 24), transform: nil)
      marker.isHidden = false
    }
    CATransaction.commit()
  }

  @objc(mouseMoved:) private func mouseMoved(with event: NSEvent) {
    guard enabled(), event.modifierFlags.contains(.option) else { return }
    showing = true
    update(event)
  }

  @objc(mouseEntered:) private func mouseEntered(with event: NSEvent) { mouseMoved(with: event) }

  @objc(mouseExited:) private func mouseExited(with event: NSEvent) {
    if !isActive { hide() }
  }
}
