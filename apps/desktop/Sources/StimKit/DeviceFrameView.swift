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
}

/// Keeps the existing display/input view inside the installed artwork's screen aperture.
@MainActor
public final class DeviceFrameNSView: NSView {
  public let screen: NSView
  public var artwork: DeviceFrameArtwork? { didSet { updateFrame() } }
  public var showsFrame = false { didSet { if oldValue != showsFrame { updateFrame() } } }
  public var quarterTurns = 0 { didSet { if oldValue != quarterTurns { updateFrame() } } }
  public var artworkScale: CGFloat? { didSet { if oldValue != artworkScale { updateFrame() } } }
  public var accurateScreenSize: CGSize? { didSet { if oldValue != accurateScreenSize { updateFrame() } } }
  public var onFrameSizeChange: (CGSize?) -> Void = { _ in }
  private let overlay = FrameOverlay()
  private var reportedSize: CGSize?
  private var artworkOffset = CGPoint.zero
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
    overlay.scale = artworkScale
    artworkOffset = .zero
    var aperture = bounds
    if let art = activeArtwork {
      let geometry = art.geometry.rotated(quarterTurns: quarterTurns)
      aperture = geometry.fitted(in: bounds, scale: artworkScale).aperture
    } else if let size = accurateScreenSize {
      aperture = CGRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2, width: size.width, height: size.height)
    }
    if artworkScale != nil || accurateScreenSize != nil {
      let backing = window?.backingScaleFactor ?? 1
      let origin = convert(aperture.origin, to: nil)
      let aligned = convert(
        CGPoint(x: (origin.x * backing).rounded() / backing, y: (origin.y * backing).rounded() / backing), from: nil)
      artworkOffset = CGPoint(x: aligned.x - aperture.minX, y: aligned.y - aperture.minY)
      aperture.origin = aligned
    }
    screen.frame = aperture
    if let art = activeArtwork {
      let geometry = art.geometry.rotated(quarterTurns: quarterTurns)
      screen.layer?.cornerRadius = art.cornerRadius * aperture.width / geometry.aperture.width
    } else {
      screen.layer?.cornerRadius = 0
    }
    screen.layer?.masksToBounds = activeArtwork != nil
    overlay.offset = artworkOffset
    needsDisplay = true
    overlay.needsDisplay = true
  }

  public override func draw(_ dirtyRect: NSRect) {
    drawFrameArtwork(
      activeArtwork, quarterTurns: quarterTurns, in: bounds, scale: artworkScale, offset: artworkOffset, foreground: false)
  }
}

@MainActor
private final class FrameOverlay: NSView {
  var artwork: DeviceFrameArtwork?
  var quarterTurns = 0
  var scale: CGFloat?
  var offset = CGPoint.zero
  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }
  override func draw(_ dirtyRect: NSRect) {
    drawFrameArtwork(artwork, quarterTurns: quarterTurns, in: bounds, scale: scale, offset: offset, foreground: true)
  }
}

@MainActor
private func drawFrameArtwork(
  _ artwork: DeviceFrameArtwork?, quarterTurns: Int, in bounds: CGRect, scale: CGFloat?, offset: CGPoint, foreground: Bool
) {
  guard let artwork, let context = NSGraphicsContext.current?.cgContext else { return }
  let turns = (quarterTurns % 4 + 4) % 4
  let size = artwork.geometry.rotated(quarterTurns: turns).size
  let scale = scale ?? min(bounds.width / size.width, bounds.height / size.height)
  context.saveGState()
  defer { context.restoreGState() }
  context.translateBy(x: bounds.midX - size.width * scale / 2 + offset.x, y: bounds.midY - size.height * scale / 2 + offset.y)
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
