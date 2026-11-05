import CoreGraphics
import IOSurface
import QuartzCore

final class DuoFoldRenderer {
  let layer = CALayer()
  private let leaves = [CALayer(), CALayer()]
  private let textures = [CALayer(), CALayer()]

  init() {
    layer.isHidden = true
    for index in leaves.indices {
      leaves[index].masksToBounds = true
      textures[index].contentsGravity = .resizeAspect
      textures[index].minificationFilter = .trilinear
      leaves[index].addSublayer(textures[index])
      layer.addSublayer(leaves[index])
    }
  }

  func show(_ surface: IOSurface?) {
    for texture in textures { texture.contents = surface }
  }

  func redraw() {
    // QuartzCore caches IOSurface contents until this SPI invalidates its copy.
    for texture in textures { _ = texture.perform(NSSelectorFromString("setContentsChanged")) }
  }

  func layout(_ projection: DuoFoldProjection, in viewport: CGRect, orientation: UInt32) {
    let size = projection.size
    layer.bounds = CGRect(origin: .zero, size: size)
    layer.position = CGPoint(x: viewport.midX, y: viewport.midY)
    let scale = projection.scale(in: viewport)
    layer.setAffineTransform(CGAffineTransform(scaleX: scale, y: scale))
    var camera = CATransform3DIdentity
    camera.m34 = -1 / projection.distance
    layer.sublayerTransform = camera
    let vertical = projection.axis == .vertical
    let rotation: CGFloat
    switch orientation {
    case 2: rotation = .pi
    case 3: rotation = -.pi / 2
    case 4: rotation = .pi / 2
    default: rotation = 0
    }
    for index in leaves.indices {
      let leaf = leaves[index]
      let origin =
        index == 0
        ? CGPoint.zero
        : CGPoint(
          x: vertical ? size.width / 2 : 0,
          y: vertical ? 0 : size.height / 2)
      leaf.bounds = CGRect(
        origin: .zero,
        size: CGSize(
          width: vertical ? size.width / 2 : size.width,
          height: vertical ? size.height : size.height / 2))
      leaf.anchorPoint =
        vertical
        ? CGPoint(x: index == 0 ? 1 : 0, y: 0.5)
        : CGPoint(x: 0.5, y: index == 0 ? 1 : 0)
      leaf.position = CGPoint(x: size.width / 2, y: size.height / 2)
      leaf.transform = CATransform3DMakeRotation(
        (index == 0 ? -1 : 1) * CGFloat((180 - projection.angle) * .pi / 360),
        vertical ? 0 : 1, vertical ? -1 : 0, 0)
      let texture = textures[index]
      texture.setAffineTransform(.identity)
      texture.bounds = CGRect(
        origin: .zero,
        size: orientation == 3 || orientation == 4 ? CGSize(width: size.height, height: size.width) : size)
      texture.position = CGPoint(x: size.width / 2 - origin.x, y: size.height / 2 - origin.y)
      texture.setAffineTransform(CGAffineTransform(rotationAngle: rotation))
    }
  }
}
