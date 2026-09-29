import CoreGraphics
import Testing

@testable import StimKit

@Suite struct ScreenPointMappingTests {
  let screen = CGSize(width: 100, height: 200)

  @Test func mapsPillarboxedViewToTopLeftFractions() {
    let view = CGSize(width: 300, height: 200)
    #expect(
      normalizedScreenPoint(CGPoint(x: 100, y: 200), viewSize: view, screenSize: screen, clamped: false)
        == CGPoint(x: 0, y: 0))
    #expect(
      normalizedScreenPoint(CGPoint(x: 175, y: 50), viewSize: view, screenSize: screen, clamped: false)
        == CGPoint(x: 0.75, y: 0.75))
  }

  @Test func mapsLetterboxedView() {
    let view = CGSize(width: 50, height: 400)
    #expect(
      normalizedScreenPoint(CGPoint(x: 25, y: 225), viewSize: view, screenSize: screen, clamped: false)
        == CGPoint(x: 0.5, y: 0.25))
  }

  @Test func rejectsLetterboxPointsUnlessClamped() {
    let view = CGSize(width: 300, height: 200)
    let outside = CGPoint(x: 20, y: 250)
    #expect(normalizedScreenPoint(outside, viewSize: view, screenSize: screen, clamped: false) == nil)
    #expect(normalizedScreenPoint(outside, viewSize: view, screenSize: screen, clamped: true) == CGPoint(x: 0, y: 0))
  }
}

@Suite struct CanvasScreenHeightTests {
  func height(_ count: Int, _ width: CGFloat, _ height: CGFloat) -> CGFloat {
    canvasScreenHeight(
      aspects: Array(repeating: 0.5, count: count), canvas: CGSize(width: width, height: height), spacing: 10,
      chrome: 100, padding: 20, minimum: 200, maximum: 640)
  }

  @Test func fillsTheHeightWithOneRowWhenTheTilesFitSideBySide() {
    #expect(height(2, 2000, 600) == 500)
  }

  @Test func wrapsIntoRowsWhenOneRowWouldShrinkThePhonesMore() {
    #expect(abs(height(4, 500, 1000) - 395) < 0.01)
  }

  @Test func countsATileNoNarrowerThanItsMinimumWidth() {
    let height = canvasScreenHeight(
      aspects: [0.45, 0.45, 0.45], canvas: CGSize(width: 700, height: 600), spacing: 16, chrome: 150, padding: 24,
      minimumWidth: 240, minimum: 260, maximum: 640)
    #expect(abs(height - 260) < 0.01)
  }

  @Test func staysAtTheMinimumAndScrollsWhenNothingFits() {
    #expect(height(4, 300, 300) == 200)
  }
}
