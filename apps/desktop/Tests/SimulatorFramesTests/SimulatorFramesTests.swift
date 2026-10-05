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

  @Test func startsFromTheDuoProvidersOrientationOnItsInnerPanel() {
    #expect(deviceOrientation(interface: 3, innerPanel: true) == 1)
    #expect(deviceOrientation(interface: 2, innerPanel: true) == 4)
    #expect(deviceOrientation(interface: 4, innerPanel: true) == 2)
    #expect(deviceOrientation(interface: 1, innerPanel: true) == 3)
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

@Suite struct DuoHingeTests {
  @Test func everyPostureRestsOutsideThePanelTurnOnItsOwnSide() {
    for posture in DuoPosture.allCases {
      let angle = posture.hingeAngle
      #expect(posture.isFolded ? angle <= DuoHinge.coverRestAngle : angle >= DuoHinge.innerRestAngle)
    }
  }

  @Test func foldingSweepsThroughTheTurnWithoutJumping() {
    let angles = DuoHinge.sweep(from: 180, to: 0)
    #expect(angles.last == 0)
    #expect(angles.count < 600)
    #expect(angles.filter { $0 > DuoHinge.coverRestAngle && $0 < DuoHinge.innerRestAngle }.count >= 10)
    let phases = [DuoHinge.phase(for: 180)] + angles.map(DuoHinge.phase(for:))
    for (previous, next) in zip(phases, phases.dropFirst()) {
      #expect(next <= previous)
      #expect(previous - next <= 1.0 / 60 + 0.0001)
    }
  }

  @Test func externalPanelChangesOverrideConflictingRememberedAngles() {
    let folded = DuoHinge.estimatedAngle(remembered: 180, folded: true)
    let halfOpen = DuoHinge.estimatedAngle(remembered: 120, folded: true)
    let unfolded = DuoHinge.estimatedAngle(remembered: 0, folded: false)
    #expect(folded == 0)
    #expect(halfOpen == 0)
    #expect(unfolded == 180)
    #expect(DuoHinge.sweep(from: folded, to: 180).last == 180)
    let reopening = DuoHinge.sweep(from: halfOpen, to: 120)
    #expect(!reopening.isEmpty)
    #expect(abs(reopening.last! - 120) < 0.001)
    #expect(DuoHinge.sweep(from: unfolded, to: 0).last == 0)
  }

  @Test func preservesIntermediateAnglesWithoutInferringDegreesFromThePanel() {
    #expect(DuoHinge.estimatedAngle(remembered: 73, folded: true) == 73)
    #expect(DuoHinge.estimatedAngle(remembered: 93, folded: false) == 93)
    #expect(DuoHinge.estimatedAngle(remembered: 147, folded: nil) == 147)
    #expect(DuoHinge.estimatedAngle(remembered: nil, folded: nil) == 180)
    #expect(DuoHinge.estimatedAngle(remembered: nil, folded: false) == 180)
    #expect(DuoHinge.estimatedAngle(remembered: nil, folded: true) == 0)
  }

  @Test func arbitraryAnglesSweepToTheSelectedAngleInBothDirections() {
    for (from, to) in [(0.0, 73.0), (180.0, 93.0), (93.0, 147.0)] {
      let angles = DuoHinge.sweep(from: from, to: to)
      #expect(abs(angles.last! - to) < 0.001)
      #expect(angles.allSatisfy { (min(from, to) - 0.001)...(max(from, to) + 0.001) ~= $0 })
    }
  }

  @Test func halfOpeningFromFoldedEndsAtTheHalfOpenAngle() {
    let angles = DuoHinge.sweep(from: 0, to: DuoPosture.halfOpen.hingeAngle)
    #expect(abs(angles.last! - 120) < 0.001)
    #expect(zip(angles, angles.dropFirst()).allSatisfy { $0 <= $1 })
  }
}

@Suite struct SimulatorHingeAngleTests {
  @Test func readsTheValidAngleRatherThanTheMechanicalAngle() {
    let sample =
      "\u{2022} +0.500s : Angle: 73.2\u{00B0} Mech: 71.8\u{00B0} Velocity:+0.0\u{00B0}/s AngleValid:Y VelocityValid:N Range:0-180\u{00B0}"
    #expect(SimulatorHingeAngle.parse(sample) == 73.2)
    #expect(SimulatorHingeAngle.parse("\u{1B}[38;5;46m" + sample + "\u{1B}[0m") == 73.2)
  }

  @Test func readsCompactAndPaddedNativeAngles() {
    for (field, expected) in [
      ("Angle:  0.0\u{00B0}", 0.0),
      ("Angle: 98.1\u{00B0}", 98.1),
      ("Angle:120.0\u{00B0}", 120.0),
      ("Angle:180.0\u{00B0}", 180.0),
    ] {
      let sample =
        "\u{2022} +0.000s : \(field)  Mech:119.2\u{00B0}  Velocity:+0.0\u{00B0}/s  AngleValid:Y  VelocityValid:N  Range:0-180\u{00B0}"
      #expect(SimulatorHingeAngle.parse(sample) == expected)
    }
  }

  @Test func ignoresUnavailableInvalidAndUnrecognizedSamples() {
    for sample in [
      "Hinge angle monitoring started. 55 seconds remaining:",
      "Angle: 73.2\u{00B0} AngleValid:N",
      "Angle: nan\u{00B0} AngleValid:Y",
      "Angle: inf\u{00B0} AngleValid:Y",
      "Angle: -1.0\u{00B0} AngleValid:Y",
      "Angle: 181.0\u{00B0} AngleValid:Y",
      "Angle: 73.2 AngleValid:Y",
      "Angle: AngleValid:Y",
      "Mech: 73.2\u{00B0} AngleValid:Y",
      "Angle: 73.2\u{00B0} AngleValid:Yunknown",
    ] {
      #expect(SimulatorHingeAngle.parse(sample) == nil)
    }
  }

}
