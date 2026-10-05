import CoreGraphics

/// The windows of an owned macOS app that viewing and Control can show, and the one they follow.
public enum OwnedAppWindows {
  /// An on-screen window of the app's process, from `CGWindowListCopyWindowInfo`, front to back.
  public struct Screen: Equatable, Sendable {
    public var id: UInt32
    public var layer: Int
    public var frame: CGRect
    public var title: String

    public init(id: UInt32, layer: Int, frame: CGRect, title: String) {
      self.id = id
      self.layer = layer
      self.frame = frame
      self.title = title
    }
  }

  /// A standard window of the app from Accessibility (`kAXWindowsAttribute`), front to back.
  public struct Accessible: Equatable, Sendable {
    public var frame: CGRect
    public var title: String
    public var main: Bool
    public var focused: Bool

    public init(frame: CGRect, title: String, main: Bool, focused: Bool) {
      self.frame = frame
      self.title = title
      self.main = main
      self.focused = focused
    }
  }

  /// `accessible` is the index of the window in the Accessibility list it was matched from, or nil without one.
  public struct Window: Equatable, Sendable {
    public var id: UInt32
    public var title: String
    public var frame: CGRect
    public var accessible: Int?

    public init(id: UInt32, title: String, frame: CGRect, accessible: Int?) {
      self.id = id
      self.title = title
      self.frame = frame
      self.accessible = accessible
    }
  }

  public struct Selection: Equatable, Sendable {
    public var current: Window
    public var windows: [Window]

    public init(current: Window, windows: [Window]) {
      self.current = current
      self.windows = windows
    }
  }

  /// Matches each standard window to the first unused on-screen layer-0 window with the same frame and title, so
  /// identical windows pair in their front-to-back order, then pairs the rest by frame alone, as the two inventories
  /// can disagree on a title that just changed. A standard window without an on-screen match (minimized, on another
  /// Space) is left out. The current window is the app's main window, else its focused one, else the frontmost.
  public static func select(screen: [Screen], accessible: [Accessible]) -> Selection? {
    var unused = screen.filter { $0.layer == 0 }
    var matched: [Int: Screen] = [:]
    for sameTitle in [true, false] {
      for (index, window) in accessible.enumerated() where matched[index] == nil {
        guard
          let match = unused.firstIndex(where: { $0.frame == window.frame && (!sameTitle || $0.title == window.title) })
        else { continue }
        matched[index] = unused.remove(at: match)
      }
    }
    let windows = accessible.indices.compactMap { index in
      matched[index].map { Window(id: $0.id, title: accessible[index].title, frame: $0.frame, accessible: index) }
    }
    let current =
      windows.first { accessible[$0.accessible!].main } ?? windows.first { accessible[$0.accessible!].focused }
      ?? windows.first
    return current.map { Selection(current: $0, windows: windows) }
  }

  /// The selection with `pinned` as its current window while that window is still one of the app's open windows;
  /// nil `pinned` in the result means the pin is gone and capture follows the front window again.
  public static func pin(_ selection: Selection, to pinned: UInt32?) -> (selection: Selection, pinned: UInt32?) {
    guard let pinned, let window = selection.windows.first(where: { $0.id == pinned }) else { return (selection, nil) }
    return (Selection(current: window, windows: selection.windows), pinned)
  }

  /// Without Accessibility, the one layer-0 window that contains every other one, such as a main window with its
  /// sheets; nil when the app shows disjoint windows.
  public static func single(screen: [Screen]) -> Selection? {
    let windows = screen.filter { $0.layer == 0 }
    let containers = windows.filter { candidate in windows.allSatisfy { candidate.frame.contains($0.frame) } }
    guard containers.count == 1, let only = containers.first else { return nil }
    let window = Window(id: only.id, title: only.title, frame: only.frame, accessible: nil)
    return Selection(current: window, windows: [window])
  }
}
