import XCTest

@testable import StimKit

final class TerminalLineTests: XCTestCase {
  func testUnchangedLinesAreNotRetypedWhenNewLinesArrive() {
    let previous = [TerminalLine(text: "$ stim ios", kind: .command), TerminalLine(text: "Building", kind: .pending)]
    let lines = previous + [TerminalLine(text: "Installed", kind: .ok)]
    XCTAssertEqual(TerminalLine.indexesToType(previous: previous, lines: lines), [2])
    XCTAssertEqual(TerminalLine.indexesToType(previous: lines, lines: lines), [])
    XCTAssertEqual(TerminalLine.indexesToType(previous: [], lines: lines), [0, 1, 2])
  }

  func testTextAndKindChangesAreTypedWithoutRetypingUnchangedRows() {
    let previous = [
      TerminalLine(text: "$ stim ios", kind: .command),
      TerminalLine(text: "Building", kind: .pending),
      TerminalLine(text: "Installed", kind: .pending),
    ]
    let lines = [
      previous[0], TerminalLine(text: "Built", kind: .pending), TerminalLine(text: "Installed", kind: .ok),
    ]
    XCTAssertEqual(TerminalLine.indexesToType(previous: previous, lines: lines), [1, 2])
  }

  func testShrinkingLinesDoesNotRetypeSurvivorsOrReturnRemovedIndexes() {
    let previous = [TerminalLine(text: "Built", kind: .ok), TerminalLine(text: "Installed", kind: .ok)]
    XCTAssertEqual(TerminalLine.indexesToType(previous: previous, lines: [previous[0]]), [])
    XCTAssertEqual(
      TerminalLine.indexesToType(previous: previous, lines: [TerminalLine(text: "Build failed", kind: .failed)]), [0])
    XCTAssertEqual(TerminalLine.indexesToType(previous: previous, lines: []), [])
  }

  func testVisibleWindowScrollsOldLinesOffAndKeepsTheRunningLineAndItsIndex() {
    let lines = (0..<12).map { TerminalLine(text: "Line \($0)", kind: $0 == 11 ? .pending : .output) }
    let window = TerminalLine.visibleWindow(lines, maxVisibleLines: 3)
    XCTAssertEqual(window.map(\.text), ["Line 9", "Line 10", "Line 11"])
    XCTAssertEqual(Array(window.indices), [9, 10, 11])
    XCTAssertEqual(window.last, lines.last)
    XCTAssertEqual(TerminalLine.visibleWindow(lines).map(\.text), (2..<12).map { "Line \($0)" })
  }

  func testVisibleWindowKeepsShortAndEmptyHistoriesAndAtLeastTheLastLine() {
    let lines = [TerminalLine(text: "Building", kind: .pending)]
    XCTAssertEqual(Array(TerminalLine.visibleWindow(lines, maxVisibleLines: 5)), lines)
    XCTAssertEqual(Array(TerminalLine.visibleWindow(lines, maxVisibleLines: 0)), lines)
    XCTAssertEqual(Array(TerminalLine.visibleWindow([])), [])
  }
}
