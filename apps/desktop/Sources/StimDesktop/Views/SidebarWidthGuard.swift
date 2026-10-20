import AppKit
import SwiftUI

struct SidebarWidthGuard: NSViewRepresentable {
  static let minimum: CGFloat = 220
  static let ideal: CGFloat = 272
  private static let hadAutosave = UserDefaults.standard.dictionaryRepresentation().keys.contains {
    $0.hasPrefix("NSSplitView Subview Frames") && $0.hasSuffix("SidebarNavigationSplitView")
  }

  static func target(for width: CGFloat, hadAutosave: Bool) -> CGFloat? {
    if width >= minimum { return nil }
    return hadAutosave ? minimum : ideal
  }

  static func prime() { _ = hadAutosave }

  func makeNSView(context: Context) -> NSView { GuardView() }
  func updateNSView(_ view: NSView, context: Context) {}

  private final class GuardView: NSView {
    private var applied = false

    override func layout() {
      super.layout()
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
