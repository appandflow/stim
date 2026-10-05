import ApplicationServices
import CoreGraphics

/// Reads one process's windows for `OwnedAppWindows`, from CoreGraphics and Accessibility.
public enum OwnedAppWindowReader {
  public struct Accessible {
    public var windows: [OwnedAppWindows.Accessible]
    public var elements: [AXUIElement]
    /// Whether any window of the app is modal, or does not say.
    public var modal: Bool
  }

  /// The process's on-screen windows, front to back; nil when the inventory or a window's metadata is unavailable.
  public static func screen(pid: pid_t) -> [OwnedAppWindows.Screen]? {
    guard
      let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]
    else { return nil }
    var screen: [OwnedAppWindows.Screen] = []
    for entry in entries where entry[kCGWindowOwnerPID as String] as? Int == Int(pid) {
      guard let id = entry[kCGWindowNumber as String] as? UInt32, let layer = entry[kCGWindowLayer as String] as? Int,
        let bounds = entry[kCGWindowBounds as String] as? [String: Any],
        let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary)
      else { return nil }
      screen.append(.init(id: id, layer: layer, frame: frame, title: entry[kCGWindowName as String] as? String ?? ""))
    }
    return screen
  }

  /// The process's standard windows, front to back; nil when Accessibility does not list its windows.
  public static func accessible(pid: pid_t) -> Accessible? {
    let application = AXUIElementCreateApplication(pid)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success,
      let owned = value as? [AXUIElement]
    else { return nil }
    var main: CFTypeRef?
    var focused: CFTypeRef?
    _ = AXUIElementCopyAttributeValue(application, kAXMainWindowAttribute as CFString, &main)
    _ = AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &focused)
    var result = Accessible(windows: [], elements: [], modal: false)
    for own in owned {
      var modal: CFTypeRef?
      if AXUIElementCopyAttributeValue(own, kAXModalAttribute as CFString, &modal) != .success || modal as? Bool != false {
        result.modal = true
      }
      var subrole: CFTypeRef?
      guard AXUIElementCopyAttributeValue(own, kAXSubroleAttribute as CFString, &subrole) == .success,
        subrole as? String == kAXStandardWindowSubrole, let frame = frame(own)
      else { continue }
      var title: CFTypeRef?
      _ = AXUIElementCopyAttributeValue(own, kAXTitleAttribute as CFString, &title)
      result.windows.append(
        .init(
          frame: frame, title: title as? String ?? "", main: main.map { CFEqual($0, own) } ?? false,
          focused: focused.map { CFEqual($0, own) } ?? false))
      result.elements.append(own)
    }
    return result
  }

  /// The windows viewing shows and follows: by Accessibility when this process is trusted, else only an app whose one
  /// window contains the others. Throws when an inventory is unavailable; nil when the app shows no window.
  public static func selection(pid: pid_t) throws -> OwnedAppWindows.Selection? {
    guard let screen = screen(pid: pid) else { throw Unavailable() }
    guard AXIsProcessTrusted() else { return OwnedAppWindows.single(screen: screen) }
    guard let accessible = accessible(pid: pid) else { throw Unavailable() }
    return OwnedAppWindows.select(screen: screen, accessible: accessible.windows)
  }

  public struct Unavailable: Error {}

  public static func frame(_ element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
      AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
      let positionValue, let sizeValue, CFGetTypeID(positionValue) == AXValueGetTypeID(),
      CFGetTypeID(sizeValue) == AXValueGetTypeID(),
      AXValueGetValue(unsafeDowncast(positionValue, to: AXValue.self), .cgPoint, &position),
      AXValueGetValue(unsafeDowncast(sizeValue, to: AXValue.self), .cgSize, &size)
    else { return nil }
    return CGRect(origin: position, size: size)
  }
}
