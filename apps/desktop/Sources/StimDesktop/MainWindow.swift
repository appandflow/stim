import AppKit

@MainActor
enum MainWindow {
  private static func isMain(_ window: NSWindow) -> Bool {
    window.identifier?.rawValue.hasPrefix("main") == true
  }

  static var isInFront: Bool {
    NSApp.isActive && NSApp.windows.contains { isMain($0) && $0.isVisible && $0.occlusionState.contains(.visible) }
  }

  static func show(open: (() -> Void)? = nil) {
    NSApp.activate(ignoringOtherApps: true)
    if let window = NSApp.windows.first(where: isMain) {
      if window.isMiniaturized { window.deminiaturize(nil) }
      window.makeKeyAndOrderFront(nil)
    } else {
      (open ?? OpenRequests.shared.openMainWindow)?()
    }
  }
}
