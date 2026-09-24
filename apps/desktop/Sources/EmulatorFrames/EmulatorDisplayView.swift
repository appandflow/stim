import AppKit
import QuartzCore
import SwiftUI

public enum EmulatorStreamStatus: Equatable, Sendable {
  case connecting
  case noEndpoint
  case streaming
}

/// Live, view-only frames of a running emulator's main display, read through
/// the gRPC endpoint in its discovery file.
public struct EmulatorDisplayView: NSViewRepresentable {
  public var serial: String
  public var onStatus: (EmulatorStreamStatus) -> Void

  public init(serial: String, onStatus: @escaping (EmulatorStreamStatus) -> Void) {
    self.serial = serial
    self.onStatus = onStatus
  }

  public func makeNSView(context: Context) -> EmulatorDisplayNSView {
    let view = EmulatorDisplayNSView()
    view.onStatus = onStatus
    view.attach(serial: serial)
    return view
  }

  public func updateNSView(_ view: EmulatorDisplayNSView, context: Context) {
    view.onStatus = onStatus
    view.attach(serial: serial)
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
    layer?.contents = nil
  }

  private func connect() {
    guard let serial, window != nil, stream == nil, retryTimer == nil else { return }
    guard let endpoint = EmulatorDiscovery.endpoint(serial: serial) else {
      report(.noEndpoint)
      retry()
      return
    }
    report(.connecting)
    generation += 1
    let current = generation
    let stream = ScreenshotStream(
      endpoint: endpoint, width: Self.maxPixels, height: Self.maxPixels,
      onFrame: { [weak self, pending] frame in
        guard pending.store(frame) else { return }
        DispatchQueue.main.async { self?.show(pending.take()) }
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

  private func show(_ frame: EmulatorFrame?) {
    guard stream != nil, let frame, let image = Self.image(frame) else { return }
    layer?.contents = image
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
    if window == nil { disconnect() } else { connect() }
  }
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
