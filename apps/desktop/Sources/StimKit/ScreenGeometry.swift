import CoreGraphics

public func fittedScreenSize(viewSize: CGSize, screenSize: CGSize) -> CGSize {
  guard screenSize.width > 0, screenSize.height > 0 else { return .zero }
  let scale = min(viewSize.width / screenSize.width, viewSize.height / screenSize.height)
  return CGSize(width: screenSize.width * scale, height: screenSize.height * scale)
}

/// Maps a point in an unflipped view that shows the screen aspect-fit and
/// centered to a fraction of the screen with a top-left origin. Returns nil
/// for a point in the letterbox unless `clamped` is true.
public func normalizedScreenPoint(_ point: CGPoint, viewSize: CGSize, screenSize: CGSize, clamped: Bool) -> CGPoint? {
  let fitted = fittedScreenSize(viewSize: viewSize, screenSize: screenSize)
  guard fitted.width > 0, fitted.height > 0 else { return nil }
  let x = (point.x - (viewSize.width - fitted.width) / 2) / fitted.width
  let y = 1 - (point.y - (viewSize.height - fitted.height) / 2) / fitted.height
  if clamped { return CGPoint(x: min(max(x, 0), 1), y: min(max(y, 0), 1)) }
  guard (0...1).contains(x), (0...1).contains(y) else { return nil }
  return CGPoint(x: x, y: y)
}
