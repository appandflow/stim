import AppKit
import Testing

@testable import StimKit

@Suite @MainActor struct DeviceFrameTests {
  @Test func accurateScaleSurvivesRoundedContainerBoundsAndRotation() {
    let screen = NSView()
    let canvas = DeviceFrameNSView(screen: screen)
    canvas.artwork = DeviceFrameArtwork(
      geometry: DeviceFrameGeometry(
        size: CGSize(width: 433, height: 903), aperture: CGRect(x: 15, y: 14, width: 402, height: 874)), background: { _ in })
    canvas.showsFrame = true
    canvas.artworkScale = 1.5
    canvas.frame = CGRect(x: 0, y: 0, width: 649, height: 1354)
    canvas.layoutSubtreeIfNeeded()
    #expect(screen.frame.size == CGSize(width: 603, height: 1311))
    #expect(screen.frame.origin.x.rounded() == screen.frame.origin.x)
    #expect(screen.frame.origin.y.rounded() == screen.frame.origin.y)

    canvas.quarterTurns = 1
    canvas.frame = CGRect(x: 0, y: 0, width: 1354, height: 649)
    canvas.layoutSubtreeIfNeeded()
    #expect(screen.frame.size == CGSize(width: 1311, height: 603))

    canvas.showsFrame = false
    canvas.accurateScreenSize = CGSize(width: 1080 / 2.625, height: 2400 / 2.625)
    canvas.frame = CGRect(x: 0, y: 0, width: 411, height: 914)
    canvas.layoutSubtreeIfNeeded()
    #expect(screen.frame.size == canvas.accurateScreenSize)
  }

  @Test func installedApertureKeepsTouchesOnScreenAndRejectsBezels() {
    let screen = NSView()
    let canvas = DeviceFrameNSView(screen: screen)
    canvas.artwork = DeviceFrameArtwork(
      geometry: DeviceFrameGeometry(
        size: CGSize(width: 130, height: 240), aperture: CGRect(x: 10, y: 20, width: 100, height: 200)),
      background: { _ in })
    canvas.showsFrame = true
    canvas.frame = CGRect(x: 0, y: 0, width: 260, height: 480)
    canvas.layoutSubtreeIfNeeded()
    #expect(screen.frame == CGRect(x: 20, y: 40, width: 200, height: 400))
    let point = screen.convert(CGPoint(x: 40, y: 100), from: canvas)
    let touch = normalizedScreenPoint(
      point, viewSize: screen.bounds.size, screenSize: CGSize(width: 100, height: 200), clamped: false)
    #expect(abs((touch?.x ?? -1) - 0.1) < 0.000001)
    #expect(abs((touch?.y ?? -1) - 0.15) < 0.000001)
    #expect(canvas.hitTest(CGPoint(x: 10, y: 100)) !== screen)
    #expect(canvas.hitTest(CGPoint(x: 40, y: 100)) === screen)

    canvas.quarterTurns = 1
    canvas.frame = CGRect(x: 0, y: 0, width: 480, height: 260)
    canvas.layoutSubtreeIfNeeded()
    #expect(screen.frame == CGRect(x: 40, y: 20, width: 400, height: 200))
    let rotated = screen.convert(CGPoint(x: 80, y: 50), from: canvas)
    let rotatedTouch = normalizedScreenPoint(
      rotated, viewSize: screen.bounds.size, screenSize: CGSize(width: 200, height: 100), clamped: false)
    #expect(abs((rotatedTouch?.x ?? -1) - 0.1) < 0.000001)
    #expect(abs((rotatedTouch?.y ?? -1) - 0.15) < 0.000001)

    canvas.showsFrame = false
    canvas.layoutSubtreeIfNeeded()
    #expect(screen.frame == canvas.bounds)
    #expect(canvas.hitTest(CGPoint(x: 10, y: 100)) === screen)
  }
  @Test func rasterLayersKeepClockwiseArtworkCoordinatesAndForegroundSeparate() throws {
    let artwork = DeviceFrameArtwork(
      geometry: DeviceFrameGeometry(
        size: CGSize(width: 100, height: 200), aperture: CGRect(x: 10, y: 20, width: 80, height: 160)),
      background: { _ in
        NSColor.red.setFill()
        CGRect(x: 0, y: 0, width: 20, height: 20).fill()
      },
      foreground: { _ in
        NSColor.blue.setFill()
        CGRect(x: 80, y: 180, width: 20, height: 20).fill()
      })
    for turn in 0...3 {
      let layers = try #require(artwork.pngLayers(quarterTurns: turn))
      let background = try #require(NSBitmapImageRep(data: layers.background))
      let foreground = try #require(NSBitmapImageRep(data: layers.foreground))
      let size = artwork.geometry.rotated(quarterTurns: turn).size
      #expect(background.pixelsWide == Int(size.width))
      #expect(background.pixelsHigh == Int(size.height))
      let redPoints = [(10, 10), (190, 10), (90, 190), (10, 90)]
      let bluePoints = [(90, 190), (10, 90), (10, 10), (190, 10)]
      let red = try #require(background.colorAt(x: redPoints[turn].0, y: redPoints[turn].1)?.usingColorSpace(.deviceRGB))
      let blue = try #require(foreground.colorAt(x: bluePoints[turn].0, y: bluePoints[turn].1)?.usingColorSpace(.deviceRGB))
      #expect(red.redComponent > 0.99 && red.alphaComponent > 0.99)
      #expect(blue.blueComponent > 0.99 && blue.alphaComponent > 0.99)
      #expect((foreground.colorAt(x: redPoints[turn].0, y: redPoints[turn].1)?.alphaComponent ?? 1) == 0)
    }
  }

}
