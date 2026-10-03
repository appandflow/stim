import AppKit
import Testing

@testable import StimKit

@Suite @MainActor struct DeviceFrameTests {
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
}
