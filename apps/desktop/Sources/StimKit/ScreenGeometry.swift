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

/// The screen height that fits every tile in `canvas`, trying one row, then two, and so on, and keeping the
/// tallest height that fits. A tile is `aspect * height + padding` wide but never narrower than `minimumWidth`, and
/// adds `chrome` to the height. The result stays between `minimum` and `maximum`; when nothing fits at `minimum`,
/// the canvas scrolls.
public func canvasScreenHeight(
  aspects: [CGFloat], canvas: CGSize, spacing: CGFloat, chrome: CGFloat, padding: CGFloat, minimumWidth: CGFloat = 0,
  minimum: CGFloat, maximum: CGFloat
) -> CGFloat {
  guard !aspects.isEmpty else { return maximum }
  func rowWidth(_ row: ArraySlice<CGFloat>, _ height: CGFloat) -> CGFloat {
    row.reduce(0) { $0 + max(minimumWidth, $1 * height + padding) } + spacing * CGFloat(row.count - 1)
  }
  var best = minimum
  for rows in 1...aspects.count {
    let columns = Int((Double(aspects.count) / Double(rows)).rounded(.up))
    let used = Int((Double(aspects.count) / Double(columns)).rounded(.up))
    let rowsOfTiles = stride(from: 0, to: aspects.count, by: columns).map {
      aspects[$0..<min($0 + columns, aspects.count)]
    }
    var low = minimum
    var high = min(maximum, (canvas.height - spacing * CGFloat(used - 1)) / CGFloat(used) - chrome)
    guard high > low, rowsOfTiles.allSatisfy({ rowWidth($0, low) <= canvas.width }) else { continue }
    for _ in 0..<24 {
      let mid = (low + high) / 2
      if rowsOfTiles.allSatisfy({ rowWidth($0, mid) <= canvas.width }) { low = mid } else { high = mid }
    }
    if rowsOfTiles.allSatisfy({ rowWidth($0, high) <= canvas.width }) { low = high }
    best = max(best, low)
  }
  return best
}
