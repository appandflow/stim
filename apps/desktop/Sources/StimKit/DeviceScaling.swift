import CoreGraphics

public enum DeviceScalingMode: String, CaseIterable, Sendable {
  case fit = "Fit"
  case pointAccurate = "Point Accurate"
  case pixelAccurate = "Pixel Accurate"
  case physicalSize = "Physical Size"
}

public struct DeviceDisplayMetrics: Equatable, Sendable {
  public var pixelsPerPoint: CGFloat
  public var pixelsPerInch: CGFloat?

  public init(pixelsPerPoint: CGFloat, pixelsPerInch: CGFloat? = nil) {
    self.pixelsPerPoint = pixelsPerPoint
    self.pixelsPerInch = pixelsPerInch
  }
}

public func displayPointsPerInch(pointWidth: CGFloat, physicalWidthMillimeters: CGFloat) -> CGFloat? {
  guard pointWidth.isFinite, pointWidth > 0, physicalWidthMillimeters.isFinite, physicalWidthMillimeters > 0 else { return nil }
  return pointWidth * 25.4 / physicalWidthMillimeters
}

/// AppKit points per guest pixel. Fit and unavailable measurements return nil.
public func devicePixelScale(
  mode: DeviceScalingMode, device: DeviceDisplayMetrics?, backingScale: CGFloat, displayPointsPerInch: CGFloat?
) -> CGFloat? {
  switch mode {
  case .fit: return nil
  case .pointAccurate:
    guard let scale = device?.pixelsPerPoint, scale.isFinite, scale > 0 else { return nil }
    return 1 / scale
  case .pixelAccurate:
    guard backingScale.isFinite, backingScale > 0 else { return nil }
    return 1 / backingScale
  case .physicalSize:
    guard let dpi = device?.pixelsPerInch, dpi.isFinite, dpi > 0,
      let points = displayPointsPerInch, points.isFinite, points > 0
    else { return nil }
    return points / dpi
  }
}
