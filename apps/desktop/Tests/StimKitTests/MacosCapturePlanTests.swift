import CoreGraphics
import XCTest

@testable import StimKit

final class MacosCapturePlanTests: XCTestCase {
  private let window = CGSize(width: 1600, height: 1000)

  func testViewerCapturesTheShownRetinaPixels() {
    let plan = MacosCapturePlan.make(
      window: window, nativeScale: 2, shown: CGSize(width: 950, height: 700), backingScale: 2, viewer: true,
      maxFramesPerSecond: 60)
    XCTAssertEqual(plan, MacosCapturePlan(width: 1900, height: 1188, framesPerSecond: 30))
  }

  func testCaptureNeverExceedsTheWindowsNativePixels() {
    let plan = MacosCapturePlan.make(
      window: window, nativeScale: 2, shown: CGSize(width: 3000, height: 3000), backingScale: 2, viewer: true,
      maxFramesPerSecond: 60)
    XCTAssertEqual(plan, MacosCapturePlan(width: 3200, height: 2000, framesPerSecond: 30))
  }

  func testShortWideAreaFitsTheHeight() {
    let plan = MacosCapturePlan.make(
      window: window, nativeScale: 2, shown: CGSize(width: 1600, height: 250), backingScale: 2, viewer: false,
      maxFramesPerSecond: 60)
    XCTAssertEqual(plan, MacosCapturePlan(width: 800, height: 500, framesPerSecond: 5))
  }

  func testFrameRateRespectsTheFramesPerSecondPreference() {
    let shown = CGSize(width: 320, height: 200)
    XCTAssertEqual(
      MacosCapturePlan.make(
        window: window, nativeScale: 2, shown: shown, backingScale: 1, viewer: true, maxFramesPerSecond: 20)?
        .framesPerSecond, 20)
    XCTAssertEqual(
      MacosCapturePlan.make(
        window: window, nativeScale: 2, shown: shown, backingScale: 1, viewer: false, maxFramesPerSecond: 3)?
        .framesPerSecond, 3)
  }

  func testNoPlanBeforeThePreviewHasASize() {
    XCTAssertNil(
      MacosCapturePlan.make(
        window: window, nativeScale: 2, shown: .zero, backingScale: 2, viewer: true, maxFramesPerSecond: 60))
  }
}
