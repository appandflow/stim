import AppKit
import QuartzCore
import SwiftUI

/// Live, view-only frames of a booted iOS simulator's main display.
public struct SimulatorDisplayView: NSViewRepresentable {
  public var udid: String

  public init(udid: String) {
    self.udid = udid
  }

  public func makeNSView(context: Context) -> SimulatorDisplayNSView {
    let view = SimulatorDisplayNSView()
    view.attach(udid: udid)
    return view
  }

  public func updateNSView(_ view: SimulatorDisplayNSView, context: Context) {
    view.attach(udid: udid)
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

  public override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window == nil { disconnect() } else { connect() }
  }
}
