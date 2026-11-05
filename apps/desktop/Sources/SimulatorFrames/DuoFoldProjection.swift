import CoreGraphics
import Foundation

struct DuoFoldProjection {
  enum Axis {
    case horizontal
    case vertical
  }

  static func axis(orientation: UInt32) -> Axis? {
    switch orientation {
    case 1, 2: return .horizontal
    case 3, 4: return .vertical
    default: return nil
    }
  }

  let size: CGSize
  let angle: Double
  let axis: Axis

  private var cosine: CGFloat { CGFloat(cos((180 - angle) * .pi / 360)) }
  private var sine: CGFloat { CGFloat(sin((180 - angle) * .pi / 360)) }
  var distance: CGFloat { 2 * max(size.width, size.height) }

  func project(_ point: CGPoint) -> CGPoint {
    let x = point.x - size.width / 2
    let y = point.y - size.height / 2
    let along = axis == .vertical ? x : y
    let across = axis == .vertical ? y : x
    let perspective = 1 - abs(along) * sine / distance
    let folded = along * cosine / perspective
    let expanded = across / perspective
    return CGPoint(
      x: size.width / 2 + (axis == .vertical ? folded : expanded),
      y: size.height / 2 + (axis == .vertical ? expanded : folded))
  }

  var projectedBounds: CGRect {
    let corners = [
      CGPoint.zero, CGPoint(x: size.width, y: 0),
      CGPoint(x: 0, y: size.height), CGPoint(x: size.width, y: size.height),
    ].map(project)
    let xs = corners.map(\.x)
    let ys = corners.map(\.y)
    return CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
  }

  func scale(in viewport: CGRect) -> CGFloat {
    let projected = projectedBounds.size
    guard projected.width > 0, projected.height > 0 else { return 0 }
    return min(viewport.width / projected.width, viewport.height / projected.height)
  }

  func viewPoint(_ source: CGPoint, in viewport: CGRect) -> CGPoint {
    let point = project(source)
    let scale = scale(in: viewport)
    return CGPoint(
      x: viewport.midX + (point.x - size.width / 2) * scale,
      y: viewport.midY + (point.y - size.height / 2) * scale)
  }

  func screenPoint(_ point: CGPoint, in viewport: CGRect, clamped: Bool = false) -> CGPoint? {
    let scale = scale(in: viewport)
    guard scale > 0 else { return nil }
    return screenPoint(
      CGPoint(
        x: size.width / 2 + (point.x - viewport.midX) / scale,
        y: size.height / 2 + (point.y - viewport.midY) / scale), clamped: clamped)
  }

  func screenPoint(_ point: CGPoint, clamped: Bool = false) -> CGPoint? {
    guard angle > 0 else { return nil }
    let x = point.x - size.width / 2
    let y = point.y - size.height / 2
    let folded = axis == .vertical ? x : y
    let expanded = axis == .vertical ? y : x
    let along = folded / (cosine + abs(folded) * sine / distance)
    let across = expanded * (1 - abs(along) * sine / distance)
    let source = CGPoint(
      x: size.width / 2 + (axis == .vertical ? along : across),
      y: size.height / 2 + (axis == .vertical ? across : along))
    let bounds = CGRect(origin: .zero, size: size).insetBy(dx: -0.000001, dy: -0.000001)
    if !clamped, !bounds.contains(source) { return nil }
    return CGPoint(
      x: min(1, max(0, source.x / size.width)),
      y: min(1, max(0, 1 - source.y / size.height)))
  }
}
