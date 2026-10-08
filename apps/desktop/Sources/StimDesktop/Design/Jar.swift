import SwiftUI

enum JarColors {
  static let glass = Color(light: 0xDDD3FFFF, dark: 0x210092FF, lightHighContrast: 0xDDD3FFFF, darkHighContrast: 0x210092FF)

  static func outline(_ scheme: ColorScheme) -> Color { scheme == .dark ? Palette.accent : Palette.brand }
}

/// The Stim jar from the branding board: a glass body drawn with thin outline strokes over a visible floor, under a
/// solid purple lid with two rim bands. `content` stands inside the glass, sized `StimJar.contentSize`.
struct StimJar<Content: View>: View {
  @ViewBuilder var content: Content
  @Environment(\.colorScheme) private var colorScheme

  static var size: CGSize { CGSize(width: 160, height: 206) }
  static var contentSize: CGSize { CGSize(width: 104, height: 104) }

  var body: some View {
    let drawing = JarDrawing(scheme: colorScheme)
    ZStack {
      Canvas { context, _ in drawing.drawGlass(context) }
      content.frame(width: Self.contentSize.width, height: Self.contentSize.height).offset(y: 20)
      Canvas { context, _ in drawing.drawFront(context) }
    }
    .frame(width: Self.size.width, height: Self.size.height)
    .accessibilityHidden(true)
  }
}

private struct JarDrawing {
  var scheme: ColorScheme
  private var outline: Color { JarColors.outline(scheme) }
  private var colorScheme: ColorScheme { scheme }

  private static let kappa: CGFloat = 0.5523
  private static let centerX: CGFloat = 80
  private static let bodyRadiusX: CGFloat = 56
  private static let bodyTop: CGFloat = 46
  private static let floorY: CGFloat = 170
  private static let floorRadiusY: CGFloat = 24
  private static let lidRadiusX: CGFloat = 64
  private static let lidRadiusY: CGFloat = 20
  private static let lidY: CGFloat = 30

  private static func lowerHalf(_ path: inout Path, from left: CGPoint, radiusX: CGFloat, radiusY: CGFloat) {
    let k = kappa
    let bottom = CGPoint(x: left.x + radiusX, y: left.y + radiusY)
    path.addCurve(
      to: bottom, control1: CGPoint(x: left.x, y: left.y + radiusY * k), control2: CGPoint(x: bottom.x - radiusX * k, y: bottom.y)
    )
    let right = CGPoint(x: left.x + 2 * radiusX, y: left.y)
    path.addCurve(
      to: right, control1: CGPoint(x: bottom.x + radiusX * k, y: bottom.y),
      control2: CGPoint(x: right.x, y: right.y + radiusY * k))
  }

  private var bodyPath: Path {
    Path { path in
      let left = CGPoint(x: Self.centerX - Self.bodyRadiusX, y: Self.floorY)
      path.move(to: CGPoint(x: left.x, y: Self.bodyTop))
      path.addLine(to: left)
      Self.lowerHalf(&path, from: left, radiusX: Self.bodyRadiusX, radiusY: Self.floorRadiusY)
      path.addLine(to: CGPoint(x: left.x + 2 * Self.bodyRadiusX, y: Self.bodyTop))
      path.closeSubpath()
    }
  }

  private var floorPath: Path {
    Path(
      ellipseIn: CGRect(
        x: Self.centerX - Self.bodyRadiusX, y: Self.floorY - Self.floorRadiusY, width: 2 * Self.bodyRadiusX,
        height: 2 * Self.floorRadiusY))
  }

  private func band(from top: CGFloat, to bottom: CGFloat) -> Path {
    Path { path in
      let left = Self.centerX - Self.lidRadiusX
      path.move(to: CGPoint(x: left, y: Self.lidY + top))
      path.addLine(to: CGPoint(x: left, y: Self.lidY + bottom))
      Self.lowerHalf(&path, from: CGPoint(x: left, y: Self.lidY + bottom), radiusX: Self.lidRadiusX, radiusY: Self.lidRadiusY)
      path.addLine(to: CGPoint(x: left + 2 * Self.lidRadiusX, y: Self.lidY + top))
      Self.lowerHalf(&path, from: CGPoint(x: left, y: Self.lidY + top), radiusX: Self.lidRadiusX, radiusY: Self.lidRadiusY)
      path.closeSubpath()
    }
  }

  func drawGlass(_ context: GraphicsContext) {
    context.fill(bodyPath, with: .color(JarColors.glass.opacity(0.28)))
    context.fill(floorPath, with: .color(JarColors.glass.opacity(0.75)))
    context.stroke(floorPath, with: .color(outline), lineWidth: 1)
  }

  func drawFront(_ context: GraphicsContext) {
    context.stroke(bodyPath, with: .color(outline), lineWidth: 1)
    var glint = Path()
    glint.move(to: CGPoint(x: 38, y: 98))
    glint.addLine(to: CGPoint(x: 38, y: 150))
    context.stroke(
      glint, with: .color(.white.opacity(colorScheme == .dark ? 0.3 : 0.9)),
      style: StrokeStyle(lineWidth: 3, lineCap: .round))

    let lower = band(from: 8, to: 16)
    context.fill(lower, with: .color(JarColors.glass))
    context.stroke(lower, with: .color(outline), lineWidth: 1)
    let upper = band(from: 0, to: 8)
    context.fill(upper, with: .color(Palette.brand))
    context.fill(upper, with: .color(.black.opacity(0.28)))
    context.stroke(upper, with: .color(outline), lineWidth: 1)

    let top = Path(
      ellipseIn: CGRect(
        x: Self.centerX - Self.lidRadiusX, y: Self.lidY - Self.lidRadiusY, width: 2 * Self.lidRadiusX, height: 2 * Self.lidRadiusY
      ))
    context.fill(top, with: .color(Palette.brand))
    context.stroke(top, with: .color(outline), lineWidth: 1)
    let gloss = Path {
      $0.move(to: CGPoint(x: 36, y: 34))
      $0.addQuadCurve(to: CGPoint(x: 62, y: 18), control: CGPoint(x: 40, y: 22))
    }
    context.stroke(gloss, with: .color(.white.opacity(0.55)), style: StrokeStyle(lineWidth: 3, lineCap: .round))
  }
}
