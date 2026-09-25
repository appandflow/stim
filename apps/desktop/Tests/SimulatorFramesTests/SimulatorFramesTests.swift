import CoreGraphics
import Testing

@testable import SimulatorFrames

@Suite struct NativeScreenPointTests {
  let topLeft = CGPoint(x: 0, y: 0)

  @Test func mapsTheUprightTopLeftCornerForEachOrientation() {
    #expect(nativeScreenPoint(topLeft, orientation: 1) == CGPoint(x: 0, y: 0))
    #expect(nativeScreenPoint(topLeft, orientation: 2) == CGPoint(x: 1, y: 1))
    #expect(nativeScreenPoint(topLeft, orientation: 3) == CGPoint(x: 0, y: 1))
    #expect(nativeScreenPoint(topLeft, orientation: 4) == CGPoint(x: 1, y: 0))
  }

  @Test func mapsAnInteriorPointInLandscape() {
    let point = CGPoint(x: 0.25, y: 0.75)
    #expect(nativeScreenPoint(point, orientation: 3) == CGPoint(x: 0.75, y: 0.75))
    #expect(nativeScreenPoint(point, orientation: 4) == CGPoint(x: 0.25, y: 0.25))
  }
}

@Suite struct QuarterTurnTests {
  @Test func rotatesPortraitToTheLandscapeOnTheTurnsSide() {
    #expect(quarterTurn(from: 1, clockwise: false) == 3)
    #expect(quarterTurn(from: 1, clockwise: true) == 4)
    #expect(quarterTurn(from: 3, clockwise: true) == 1)
    #expect(quarterTurn(from: 4, clockwise: true) == 2)
  }

  @Test func startsFromTheDeviceOrientationThatShowsTheInterfaceUpright() {
    #expect(deviceOrientation(interface: 4) == 3)
    #expect(deviceOrientation(interface: 3) == 4)
  }
}
