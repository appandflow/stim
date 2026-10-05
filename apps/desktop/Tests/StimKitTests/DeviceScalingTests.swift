import XCTest

@testable import StimKit

final class DeviceScalingTests: XCTestCase {
  func testRetinaGuestPixelsAndLogicalPointsUseDifferentScales() {
    let device = DeviceDisplayMetrics(pixelsPerPoint: 3, pixelsPerInch: 460)
    XCTAssertEqual(devicePixelScale(mode: .pointAccurate, device: device, backingScale: 2, displayPointsPerInch: nil), 1 / 3)
    XCTAssertEqual(devicePixelScale(mode: .pixelAccurate, device: device, backingScale: 2, displayPointsPerInch: nil), 0.5)
    XCTAssertEqual(devicePixelScale(mode: .pixelAccurate, device: device, backingScale: 1, displayPointsPerInch: nil), 1)
  }

  func testPhysicalScaleUsesMonitorPointsInsteadOfBackingPixels() throws {
    let points = try XCTUnwrap(displayPointsPerInch(pointWidth: 1920, physicalWidthMillimeters: 508))
    let scale = try XCTUnwrap(
      devicePixelScale(
        mode: .physicalSize, device: DeviceDisplayMetrics(pixelsPerPoint: 3, pixelsPerInch: 460), backingScale: 2,
        displayPointsPerInch: points))
    XCTAssertEqual(460 * scale, 96, accuracy: 0.0001)
    XCTAssertEqual(displayPointsPerInch(pointWidth: 2560, physicalWidthMillimeters: 508), 128)
  }

  func testAndroidDpDensityDoesNotEnablePhysicalSize() {
    let android = DeviceDisplayMetrics(pixelsPerPoint: 420 / 160)
    XCTAssertEqual(devicePixelScale(mode: .pointAccurate, device: android, backingScale: 2, displayPointsPerInch: 96), 160 / 420)
    XCTAssertNil(devicePixelScale(mode: .physicalSize, device: android, backingScale: 2, displayPointsPerInch: 96))
  }

  func testMissingMeasurementsCannotProduceAnAccurateScale() {
    XCTAssertNil(displayPointsPerInch(pointWidth: 1920, physicalWidthMillimeters: 0))
    XCTAssertNil(devicePixelScale(mode: .pointAccurate, device: nil, backingScale: 2, displayPointsPerInch: nil))
    XCTAssertNil(
      devicePixelScale(
        mode: .physicalSize, device: DeviceDisplayMetrics(pixelsPerPoint: 3, pixelsPerInch: 460), backingScale: 2,
        displayPointsPerInch: nil))
    XCTAssertNil(devicePixelScale(mode: .fit, device: nil, backingScale: 2, displayPointsPerInch: nil))
  }
}
