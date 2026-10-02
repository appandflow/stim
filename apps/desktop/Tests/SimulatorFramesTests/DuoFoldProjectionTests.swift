import AppKit
import CoreGraphics
import IOSurface
import QuartzCore
import Testing

@testable import SimulatorFrames

@Suite struct DuoFoldProjectionTests {
  @Test func projectedTouchesReachTheSameNativePixelInEveryOrientation() throws {
    for axis in [DuoFoldProjection.Axis.horizontal, .vertical] {
      for angle in [1.0, 73, 120, 179, 180] {
        let projection = DuoFoldProjection(size: CGSize(width: 600, height: 400), angle: angle, axis: axis)
        for source in [
          CGPoint(x: 0, y: 0), CGPoint(x: 600, y: 400),
          CGPoint(x: 60, y: 80), CGPoint(x: 300, y: 200), CGPoint(x: 540, y: 320),
        ] {
          let expected = CGPoint(x: source.x / 600, y: 1 - source.y / 400)
          let actual = try #require(projection.screenPoint(projection.project(source)))
          for orientation in UInt32(1)...UInt32(4) {
            let native = nativeScreenPoint(actual, orientation: orientation)
            let target = nativeScreenPoint(expected, orientation: orientation)
            #expect(abs(native.x - target.x) < 0.000001)
            #expect(abs(native.y - target.y) < 0.000001)
          }
        }
      }
    }
  }

  @Test func projectedLeavesMatchCoreAnimationRotationAndPerspective() {
    for axis in [DuoFoldProjection.Axis.horizontal, .vertical] {
      for angle in [73.0, 120, 180] {
        let projection = DuoFoldProjection(size: CGSize(width: 600, height: 400), angle: angle, axis: axis)
        for source in [CGPoint(x: 60, y: 80), CGPoint(x: 540, y: 320)] {
          let x = source.x - 300
          let y = source.y - 200
          let along = axis == .vertical ? x : y
          let sign: CGFloat = along < 0 ? -1 : 1
          let rotation = CATransform3DMakeRotation(
            sign * CGFloat((180 - angle) * .pi / 360), axis == .vertical ? 0 : 1,
            axis == .vertical ? -1 : 0, 0)
          var camera = CATransform3DIdentity
          camera.m34 = -1.0 / 1200
          let transform = CATransform3DConcat(rotation, camera)
          let w = x * transform.m14 + y * transform.m24 + transform.m44
          let expected = CGPoint(
            x: 300 + (x * transform.m11 + y * transform.m21) / w,
            y: 200 + (x * transform.m12 + y * transform.m22) / w)
          let actual = projection.project(source)
          #expect(abs(actual.x - expected.x) < 0.000001)
          #expect(abs(actual.y - expected.y) < 0.000001)
        }
      }
    }
  }

  @Test func anOpenScreenStaysFlat() {
    let source = CGPoint(x: 123, y: 345)
    for axis in [DuoFoldProjection.Axis.horizontal, .vertical] {
      let projection = DuoFoldProjection(size: CGSize(width: 600, height: 400), angle: 180, axis: axis)
      #expect(projection.project(source) == source)
    }
  }

  @Test func theHingeStaysFixedWhileBothLeavesFoldTowardTheViewer() {
    let projection = DuoFoldProjection(size: CGSize(width: 600, height: 400), angle: 120, axis: .vertical)
    #expect(projection.project(CGPoint(x: 300, y: 70)) == CGPoint(x: 300, y: 70))
    let left = projection.project(CGPoint(x: 0, y: 400))
    let right = projection.project(CGPoint(x: 600, y: 400))
    #expect(left.x > 0)
    #expect(right.x < 600)
    #expect(left.y > 400)
    #expect(left.y == right.y)
    #expect(abs(left.x + right.x - 600) < 0.000001)
  }

  @Test func blankSpaceDoesNotStartATouchButDraggingClampsToTheLeafEdge() {
    let projection = DuoFoldProjection(size: CGSize(width: 600, height: 400), angle: 73, axis: .vertical)
    let blank = CGPoint(x: 0, y: 200)
    #expect(projection.screenPoint(blank) == nil)
    #expect(projection.screenPoint(blank, clamped: true) == CGPoint(x: 0, y: 0.5))
    #expect(projection.screenPoint(CGPoint(x: 300, y: 500)) == nil)
    #expect(projection.screenPoint(CGPoint(x: 300, y: 500), clamped: true) == CGPoint(x: 0.5, y: 0))
  }

  @Test func anEdgeOnInnerScreenCannotReceiveATouch() {
    for axis in [DuoFoldProjection.Axis.horizontal, .vertical] {
      let projection = DuoFoldProjection(size: CGSize(width: 600, height: 400), angle: 0, axis: axis)
      #expect(projection.screenPoint(CGPoint(x: 300, y: 200)) == nil)
      #expect(projection.screenPoint(CGPoint(x: 300, y: 200), clamped: true) == nil)
    }
  }

  @Test func theViewportFitsEveryProjectedCornerAndInvertsScaledTouches() throws {
    for axis in [DuoFoldProjection.Axis.horizontal, .vertical] {
      for angle in [1.0, 73, 120, 180] {
        let projection = DuoFoldProjection(size: CGSize(width: 600, height: 400), angle: angle, axis: axis)
        for viewport in [CGRect(x: 0, y: 0, width: 500, height: 700), CGRect(x: 10, y: 20, width: 900, height: 300)] {
          for source in [CGPoint.zero, CGPoint(x: 600, y: 400), CGPoint(x: 600, y: 0), CGPoint(x: 0, y: 400)] {
            let viewPoint = projection.viewPoint(source, in: viewport)
            #expect(viewport.insetBy(dx: -0.000001, dy: -0.000001).contains(viewPoint))
            let actual = try #require(projection.screenPoint(viewPoint, in: viewport))
            #expect(abs(actual.x - source.x / 600) < 0.000001)
            #expect(abs(actual.y - (1 - source.y / 400)) < 0.000001)
          }
        }
      }
    }
  }

  @Test @MainActor func nativeViewUsesTheSameLiveSurfaceAndProjectedTouchCoordinates() throws {
    let surface = try #require(
      IOSurface(properties: [
        .width: 600, .height: 400, .bytesPerElement: 4,
        .bytesPerRow: 2400, .pixelFormat: 0x42475241,
      ]))
    let view = SimulatorDisplayNSView(frame: CGRect(x: 0, y: 0, width: 500, height: 700))
    for orientation in UInt32(1)...UInt32(4) {
      view.showSurface(surface, orientation: orientation)
      let size = orientation == 3 || orientation == 4 ? CGSize(width: 400, height: 600) : CGSize(width: 600, height: 400)
      let axis = try #require(DuoFoldProjection.axis(orientation: orientation))
      do {
        view.hingeAngle = 73
        view.layout()
        let root = try #require(view.layer)
        let flat = try #require(root.sublayers?.first)
        let folded = try #require(root.sublayers?.last)
        #expect(flat.isHidden)
        #expect(!folded.isHidden)
        let leaves = try #require(folded.sublayers)
        #expect(leaves.count == 2)
        for leaf in leaves {
          let texture = try #require(leaf.sublayers?.first)
          #expect((texture.contents as? IOSurface) === surface)
        }
        let projection = DuoFoldProjection(size: size, angle: 73, axis: axis)
        for source in [
          CGPoint(x: size.width * 0.2, y: size.height * 0.7),
          CGPoint(x: size.width * 0.8, y: size.height * 0.3),
        ] {
          let point = projection.viewPoint(source, in: view.bounds)
          let actual = try #require(view.screenPoint(point, clamped: false))
          #expect(abs(actual.x - source.x / size.width) < 0.000001)
          #expect(abs(actual.y - (1 - source.y / size.height)) < 0.000001)
        }
      }
    }
    view.hingeAngle = nil
    view.layout()
    #expect(view.layer?.sublayers?.first?.isHidden == false)
    #expect(view.layer?.sublayers?.last?.isHidden == true)
    view.detach()
    for leaf in view.layer?.sublayers?.last?.sublayers ?? [] { #expect(leaf.sublayers?.first?.contents == nil) }
  }

  @Test @MainActor func nativeInnerAxisRotatesFromTheVerifiedUIKitDivisionAndUnknownStaysFlat() throws {
    let surface = try #require(
      IOSurface(properties: [
        .width: 2007, .height: 2853,
        .bytesPerElement: 4, .bytesPerRow: 8028, .pixelFormat: 0x42475241,
      ]))
    let view = SimulatorDisplayNSView(frame: CGRect(x: 0, y: 0, width: 600, height: 600))
    view.hingeAngle = 90
    for (orientation, expectedAxis) in [
      (UInt32(3), DuoFoldProjection.Axis.vertical),
      (2, .horizontal), (4, .vertical), (1, .horizontal),
    ] {
      #expect(DuoFoldProjection.axis(orientation: orientation) == expectedAxis)
      view.showSurface(surface, orientation: orientation)
      view.layout()
      let folded = try #require(view.layer?.sublayers?.last)
      let leaf = try #require(folded.sublayers?.first)
      let expected = expectedAxis == .vertical ? CGPoint(x: 1, y: 0.5) : CGPoint(x: 0.5, y: 1)
      #expect(leaf.anchorPoint == expected)
    }
    view.showSurface(surface, orientation: 0)
    view.layout()
    #expect(view.layer?.sublayers?.first?.isHidden == false)
    #expect(view.layer?.sublayers?.last?.isHidden == true)
    view.showSurface(surface, orientation: 3)
    view.hingeAngle = 180
    view.layout()
    #expect(view.layer?.sublayers?.first?.isHidden == false)
    #expect(view.layer?.sublayers?.last?.isHidden == true)
  }

}
