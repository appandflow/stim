import CoreGraphics
import Testing

@testable import StimKit

@Suite struct ScreenPointMappingTests {
  let screen = CGSize(width: 100, height: 200)

  @Test func mapsPillarboxedViewToTopLeftFractions() {
    let view = CGSize(width: 300, height: 200)
    #expect(normalizedScreenPoint(CGPoint(x: 100, y: 200), viewSize: view, screenSize: screen, clamped: false)
      == CGPoint(x: 0, y: 0))
    #expect(normalizedScreenPoint(CGPoint(x: 175, y: 50), viewSize: view, screenSize: screen, clamped: false)
      == CGPoint(x: 0.75, y: 0.75))
  }

  @Test func mapsLetterboxedView() {
    let view = CGSize(width: 50, height: 400)
    #expect(normalizedScreenPoint(CGPoint(x: 25, y: 225), viewSize: view, screenSize: screen, clamped: false)
      == CGPoint(x: 0.5, y: 0.25))
  }

  @Test func rejectsLetterboxPointsUnlessClamped() {
    let view = CGSize(width: 300, height: 200)
    let outside = CGPoint(x: 20, y: 250)
    #expect(normalizedScreenPoint(outside, viewSize: view, screenSize: screen, clamped: false) == nil)
    #expect(normalizedScreenPoint(outside, viewSize: view, screenSize: screen, clamped: true) == CGPoint(x: 0, y: 0))
  }
}
