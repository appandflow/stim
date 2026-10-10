import AppKit
import SwiftUI

/// Keeps the main window's sidebar at or above its minimum width. A launch with no saved split view
/// frames starts at the ideal width; a restored width below the minimum is raised to the minimum.
struct SidebarWidthGuard: NSViewRepresentable {
  static let minimum: CGFloat = 220
  static let ideal: CGFloat = 272
  private static let autosaveKey = "NSSplitView Subview Frames main, SidebarNavigationSplitView"
  private static let hadAutosave = UserDefaults.standard.object(forKey: autosaveKey) != nil

  static func target(for width: CGFloat, hadAutosave: Bool) -> CGFloat? {
    if width >= minimum { return nil }
    return hadAutosave ? minimum : ideal
  }

  static func prime() { _ = hadAutosave }

  func makeNSView(context: Context) -> NSView { GuardView() }
  func updateNSView(_ view: NSView, context: Context) {}

  private final class GuardView: NSView {
    private var applied = false

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      guard window != nil, !applied else { return }
      DispatchQueue.main.async { [weak self] in self?.apply() }
    }

    private func apply() {
      guard !applied else { return }
      var ancestor = superview
      while let view = ancestor, !(view is NSSplitView) { ancestor = view.superview }
      guard let split = ancestor as? NSSplitView, let sidebar = split.arrangedSubviews.first,
        sidebar.frame.width > 0
      else { return }
      applied = true
      guard let width = SidebarWidthGuard.target(for: sidebar.frame.width, hadAutosave: SidebarWidthGuard.hadAutosave) else {
        return
      }
      split.setPosition(width, ofDividerAt: 0)
    }
  }
}
