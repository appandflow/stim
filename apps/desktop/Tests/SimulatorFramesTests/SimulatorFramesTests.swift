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

@Suite struct KeyUsageTests {
  @Test(.enabled(if: SimulatorKit.usageForKeyCode != nil, "needs an Xcode whose SimulatorKit exports hidUsageForCGKeyCode"))
  func mapsEditingAndNavigationKeysToTheirHIDUsages() throws {
    let usage = try #require(SimulatorKit.usageForKeyCode)
    let expected: [(keyCode: UInt32, usage: UInt32)] = [
      (0, 0x04), (36, 0x28), (53, 0x29), (51, 0x2A), (48, 0x2B), (49, 0x2C),
      (115, 0x4A), (116, 0x4B), (117, 0x4C), (119, 0x4D), (121, 0x4E),
      (124, 0x4F), (123, 0x50), (125, 0x51), (126, 0x52), (56, 0xE1),
    ]
    for key in expected {
      #expect(usage(key.keyCode) == key.usage, "key code \(key.keyCode)")
    }
  }
}
