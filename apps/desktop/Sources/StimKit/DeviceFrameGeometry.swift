import CoreGraphics

/// Installed frame coordinates use a top-left origin, with the screen kept at its native aspect ratio.
public struct DeviceFrameGeometry: Equatable, Sendable {
  public var size: CGSize
  public var aperture: CGRect

  public init(size: CGSize, aperture: CGRect) {
    self.size = size
    self.aperture = aperture
  }

  public func rotated(quarterTurns: Int) -> Self {
    switch (quarterTurns % 4 + 4) % 4 {
    case 1:
      return Self(
        size: CGSize(width: size.height, height: size.width),
        aperture: CGRect(x: size.height - aperture.maxY, y: aperture.minX, width: aperture.height, height: aperture.width))
    case 2:
      return Self(
        size: size,
        aperture: CGRect(
          x: size.width - aperture.maxX, y: size.height - aperture.maxY, width: aperture.width, height: aperture.height))
    case 3:
      return Self(
        size: CGSize(width: size.height, height: size.width),
        aperture: CGRect(x: aperture.minY, y: size.width - aperture.maxX, width: aperture.height, height: aperture.width))
    default: return self
    }
  }

  public func fitted(in bounds: CGRect) -> Self {
    let scale = min(bounds.width / size.width, bounds.height / size.height)
    let origin = CGPoint(x: bounds.midX - size.width * scale / 2, y: bounds.midY - size.height * scale / 2)
    return Self(
      size: CGSize(width: size.width * scale, height: size.height * scale),
      aperture: CGRect(
        x: origin.x + aperture.minX * scale, y: origin.y + aperture.minY * scale,
        width: aperture.width * scale, height: aperture.height * scale))
  }
}
