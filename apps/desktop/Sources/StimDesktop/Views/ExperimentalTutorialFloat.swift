import AppKit
import SwiftUI

/// The window is a non-activating `NSPanel`, so clicking it never takes focus from the app the user works in.
struct ExperimentalTutorialFloat<Content: View>: NSViewRepresentable {
  var isPresented: Bool
  var pinned: Bool
  @ViewBuilder var content: () -> Content

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeNSView(context: Context) -> NSView { NSView() }

  func updateNSView(_ view: NSView, context: Context) {
    context.coordinator.update(
      isPresented: isPresented, pinned: pinned, ownerWindow: view.window ?? NSApp.mainWindow, content: AnyView(content()))
  }

  static func dismantleNSView(_ view: NSView, coordinator: Coordinator) { coordinator.close() }

  @MainActor final class Coordinator {
    private var panel: NSPanel?
    private var hosting: NSHostingView<AnyView>?

    func update(isPresented: Bool, pinned: Bool, ownerWindow: NSWindow?, content: AnyView) {
      guard isPresented else { return close() }
      if let hosting {
        hosting.rootView = content
      } else {
        let hosting = NSHostingView(rootView: content)
        let panel = NSPanel(
          contentRect: NSRect(x: 0, y: 0, width: WorkspaceDetail.inspectorWidth, height: 640),
          styleMask: [.titled, .resizable, .utilityWindow, .nonactivatingPanel, .fullSizeContentView],
          backing: .buffered, defer: false)
        panel.title = "Stim Tutorial"
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.isMovableByWindowBackground = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentMinSize = NSSize(width: WorkspaceDetail.inspectorWidth, height: 420)
        panel.contentView = hosting
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
          panel.standardWindowButton(button)?.isHidden = true
        }
        if let owner = ownerWindow, let screen = owner.screen?.visibleFrame {
          let width = panel.frame.width
          let height = panel.frame.height
          let right = owner.frame.maxX + 12
          let left = owner.frame.minX - width - 12
          let preferredX = right + width <= screen.maxX ? right : left
          let x = max(screen.minX, min(preferredX, screen.maxX - width))
          let y = max(screen.minY, min(owner.frame.maxY - height, screen.maxY - height))
          panel.setFrameOrigin(NSPoint(x: x, y: y))
        }
        self.panel = panel
        self.hosting = hosting
      }
      panel?.isFloatingPanel = pinned
      panel?.level = pinned ? .floating : .normal
      if panel?.isVisible == false { panel?.orderFrontRegardless() }
    }

    func close() {
      panel?.orderOut(nil)
      panel = nil
      hosting = nil
    }

  }
}
