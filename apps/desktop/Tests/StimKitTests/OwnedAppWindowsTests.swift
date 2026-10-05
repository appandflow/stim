import CoreGraphics
import Testing

@testable import StimKit

@Suite struct OwnedAppWindowsTests {
  let big = CGRect(x: 510, y: 287, width: 900, height: 450)
  let settings = CGRect(x: 780, y: 288, width: 360, height: 448)
  let sheet = CGRect(x: 810, y: 412, width: 300, height: 200)

  @Test func matchesWindowsWithTheSameFrameByTitle() {
    let selection = OwnedAppWindows.select(
      screen: [
        .init(id: 3, layer: 0, frame: settings, title: "Settings"),
        .init(id: 2, layer: 0, frame: big, title: "Tools"),
        .init(id: 1, layer: 0, frame: big, title: "Main"),
      ],
      accessible: [
        .init(frame: big, title: "Main", main: true, focused: true),
        .init(frame: settings, title: "Settings", main: false, focused: false),
        .init(frame: big, title: "Tools", main: false, focused: false),
      ])
    #expect(selection?.current.id == 1)
    #expect(selection?.windows.map(\.id) == [1, 3, 2])
    #expect(selection?.windows.map(\.accessible) == [0, 1, 2])
  }

  @Test func pairsIdenticalWindowsFrontToBack() {
    let selection = OwnedAppWindows.select(
      screen: [.init(id: 8, layer: 0, frame: big, title: "Doc"), .init(id: 5, layer: 0, frame: big, title: "Doc")],
      accessible: [
        .init(frame: big, title: "Doc", main: false, focused: false),
        .init(frame: big, title: "Doc", main: true, focused: true),
      ])
    #expect(selection?.windows.map(\.id) == [8, 5])
    #expect(selection?.current.id == 5)
  }

  @Test func matchesAWindowWhoseTitleJustChangedByFrame() {
    let selection = OwnedAppWindows.select(
      screen: [
        .init(id: 3, layer: 0, frame: settings, title: "App"), .init(id: 2, layer: 0, frame: big, title: "Tools"),
        .init(id: 1, layer: 0, frame: big, title: "Main"),
      ],
      accessible: [
        .init(frame: settings, title: "Build Machines", main: true, focused: true),
        .init(frame: big, title: "Main", main: false, focused: false),
        .init(frame: big, title: "Tools", main: false, focused: false),
      ])
    #expect(selection?.current == .init(id: 3, title: "Build Machines", frame: settings, accessible: 0))
    #expect(selection?.windows.map(\.id) == [3, 1, 2])
  }

  @Test func followsTheMainWindowWhileItsSheetHasFocus() {
    let selection = OwnedAppWindows.select(
      screen: [
        .init(id: 9, layer: 0, frame: sheet, title: ""),
        .init(id: 1, layer: 0, frame: big, title: "Main"),
        .init(id: 3, layer: 0, frame: settings, title: "Settings"),
        .init(id: 4, layer: 25, frame: big, title: "Menu"),
      ],
      accessible: [
        .init(frame: big, title: "Main", main: true, focused: false),
        .init(frame: settings, title: "Settings", main: false, focused: false),
      ])
    #expect(selection?.current.id == 1)
    #expect(selection?.windows.map(\.id) == [1, 3])
  }

  @Test func fallsBackToTheFocusedThenFrontmostOnScreenWindow() {
    let screen: [OwnedAppWindows.Screen] = [
      .init(id: 3, layer: 0, frame: settings, title: "Settings"), .init(id: 2, layer: 0, frame: big, title: "Tools"),
    ]
    let minimizedMain = OwnedAppWindows.Accessible(frame: big, title: "Main", main: true, focused: false)
    let focused = OwnedAppWindows.select(
      screen: screen,
      accessible: [
        minimizedMain, .init(frame: settings, title: "Settings", main: false, focused: false),
        .init(frame: big, title: "Tools", main: false, focused: true),
      ])
    #expect(focused?.current.id == 2)
    #expect(focused?.windows.map(\.id) == [3, 2])
    let frontmost = OwnedAppWindows.select(
      screen: screen,
      accessible: [
        minimizedMain, .init(frame: settings, title: "Settings", main: false, focused: false),
        .init(frame: big, title: "Tools", main: false, focused: false),
      ])
    #expect(frontmost?.current.id == 3)
    #expect(
      OwnedAppWindows.select(
        screen: [.init(id: 6, layer: 0, frame: sheet, title: "Inspector")], accessible: [minimizedMain]) == nil)
  }

  @Test func withoutAccessibilityNeedsOneWindowContainingTheOthers() {
    let main = OwnedAppWindows.Screen(id: 1, layer: 0, frame: big, title: "Main")
    let withSheet = OwnedAppWindows.single(screen: [.init(id: 9, layer: 0, frame: sheet, title: ""), main])
    #expect(withSheet?.current.id == 1)
    #expect(withSheet?.windows.map(\.id) == [1])
    #expect(
      OwnedAppWindows.single(screen: [
        main, .init(id: 3, layer: 0, frame: settings.offsetBy(dx: 900, dy: 0), title: "Settings"),
      ]) == nil)
  }
}
