import AppKit

/// Artwork is loaded from the user's installed developer tools, never bundled with Stim.
@MainActor
public final class DeviceFrameArtwork {
  public let geometry: DeviceFrameGeometry
  public let cornerRadius: CGFloat
  let background: (CGRect) -> Void
  let foreground: (CGRect) -> Void

  public init(
    geometry: DeviceFrameGeometry, cornerRadius: CGFloat = 0,
    background: @escaping (CGRect) -> Void, foreground: @escaping (CGRect) -> Void = { _ in }
  ) {
    self.geometry = geometry
    self.cornerRadius = cornerRadius
    self.background = background
    self.foreground = foreground
  }

  /// Rasterizes installed artwork in upright frame coordinates, keeping screen pixels out of both PNG layers.
  public func pngLayers(quarterTurns: Int) -> (background: Data, foreground: Data)? {
    let size = geometry.rotated(quarterTurns: quarterTurns).size
    let scale = min(1, 2048 / max(size.width, size.height))
    let bounds = CGRect(x: 0, y: 0, width: ceil(size.width * scale), height: ceil(size.height * scale))
    func layer(foreground: Bool) -> Data? {
      guard
        let bitmap = NSBitmapImageRep(
          bitmapDataPlanes: nil, pixelsWide: Int(bounds.width), pixelsHigh: Int(bounds.height),
          bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
          colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: bitmap)
      else { return nil }
      NSGraphicsContext.saveGraphicsState()
      defer { NSGraphicsContext.restoreGraphicsState() }
      context.cgContext.clear(bounds)
      context.cgContext.translateBy(x: 0, y: bounds.height)
      context.cgContext.scaleBy(x: 1, y: -1)
      NSGraphicsContext.current = NSGraphicsContext(cgContext: context.cgContext, flipped: true)
      drawFrameArtwork(self, quarterTurns: quarterTurns, in: bounds, foreground: foreground)
      return bitmap.representation(using: .png, properties: [:])
    }
    guard let background = layer(foreground: false), let foreground = layer(foreground: true) else { return nil }
    return (background, foreground)
  }
}

/// Keeps the existing display/input view inside the installed artwork's screen aperture.
@MainActor
public final class DeviceFrameNSView: NSView {
  public let screen: NSView
  public var artwork: DeviceFrameArtwork? { didSet { updateFrame() } }
  public var showsFrame = false { didSet { if oldValue != showsFrame { updateFrame() } } }
  public var quarterTurns = 0 { didSet { if oldValue != quarterTurns { updateFrame() } } }
  public var onFrameSizeChange: (CGSize?) -> Void = { _ in }
  private let overlay = FrameOverlay()
  private var reportedSize: CGSize?
  public override var isFlipped: Bool { true }

  public init(screen: NSView) {
    self.screen = screen
    super.init(frame: .zero)
    addSubview(screen)
    addSubview(overlay)
  }

  required init?(coder: NSCoder) { nil }

  private var activeArtwork: DeviceFrameArtwork? { showsFrame ? artwork : nil }

  private func updateFrame() {
    needsLayout = true
    needsDisplay = true
    overlay.needsDisplay = true
    let size = artwork?.geometry.rotated(quarterTurns: quarterTurns).size
    guard size != reportedSize else { return }
    reportedSize = size
    DispatchQueue.main.async { [weak self] in self?.onFrameSizeChange(size) }
  }

  public override func layout() {
    super.layout()
    overlay.frame = bounds
    overlay.artwork = activeArtwork
    overlay.quarterTurns = quarterTurns
    if let art = activeArtwork {
      let geometry = art.geometry.rotated(quarterTurns: quarterTurns)
      screen.frame = geometry.fitted(in: bounds).aperture
      screen.layer?.cornerRadius = art.cornerRadius * screen.frame.width / geometry.aperture.width
      screen.layer?.masksToBounds = true
    } else {
      screen.frame = bounds
      screen.layer?.cornerRadius = 0
      screen.layer?.masksToBounds = false
    }
    needsDisplay = true
    overlay.needsDisplay = true
  }

  public override func draw(_ dirtyRect: NSRect) {
    drawFrameArtwork(activeArtwork, quarterTurns: quarterTurns, in: bounds, foreground: false)
  }
}

@MainActor
private final class FrameOverlay: NSView {
  var artwork: DeviceFrameArtwork?
  var quarterTurns = 0
  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func draw(_ dirtyRect: NSRect) {
    drawFrameArtwork(artwork, quarterTurns: quarterTurns, in: bounds, foreground: true)
  }
}

@MainActor
private func drawFrameArtwork(_ artwork: DeviceFrameArtwork?, quarterTurns: Int, in bounds: CGRect, foreground: Bool) {
  guard let artwork, let context = NSGraphicsContext.current?.cgContext else { return }
  let turns = (quarterTurns % 4 + 4) % 4
  let size = artwork.geometry.rotated(quarterTurns: turns).size
  let scale = min(bounds.width / size.width, bounds.height / size.height)
  context.saveGState()
  defer { context.restoreGState() }
  context.translateBy(x: bounds.midX - size.width * scale / 2, y: bounds.midY - size.height * scale / 2)
  context.scaleBy(x: scale, y: scale)
  switch turns {
  case 1:
    context.translateBy(x: artwork.geometry.size.height, y: 0)
    context.rotate(by: .pi / 2)
  case 2:
    context.translateBy(x: artwork.geometry.size.width, y: artwork.geometry.size.height)
    context.rotate(by: .pi)
  case 3:
    context.translateBy(x: 0, y: artwork.geometry.size.width)
    context.rotate(by: -.pi / 2)
  default: break
  }
  if foreground {
    artwork.foreground(CGRect(origin: .zero, size: artwork.geometry.size))
  } else {
    artwork.background(CGRect(origin: .zero, size: artwork.geometry.size))
  }
}
