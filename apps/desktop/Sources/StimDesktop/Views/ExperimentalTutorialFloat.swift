import AppKit
import SwiftUI

/// The window is a non-activating `NSPanel`, so clicking it never takes focus from the app the user works in.
struct ExperimentalTutorialFloat<Content: View>: NSViewRepresentable {
  var isPresented: Bool
  @ViewBuilder var content: () -> Content

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeNSView(context: Context) -> NSView { NSView() }

  func updateNSView(_ view: NSView, context: Context) {
    context.coordinator.update(
      isPresented: isPresented, ownerWindow: view.window ?? NSApp.mainWindow, content: AnyView(content()))
  }

  static func dismantleNSView(_ view: NSView, coordinator: Coordinator) { coordinator.close() }

  @MainActor final class Coordinator {
    private var panel: NSPanel?
    private var hosting: NSHostingView<AnyView>?
    private weak var owner: NSWindow?
    private var observers: [NSObjectProtocol] = []
    private var content = AnyView(EmptyView())
    private var popupOpen = false

    func update(isPresented: Bool, ownerWindow: NSWindow?, content: AnyView) {
      guard isPresented else { return close() }
      self.content = content
      if owner !== ownerWindow {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        owner = ownerWindow
        popupOpen = ownerWindow?.attachedSheet != nil
        if let ownerWindow {
          observers = [
            NotificationCenter.default.addObserver(
              forName: NSWindow.willBeginSheetNotification, object: ownerWindow, queue: .main
            ) { [weak self] _ in
              MainActor.assumeIsolated {
                self?.popupOpen = true
                self?.refreshContent()
              }
            },
            NotificationCenter.default.addObserver(
              forName: NSWindow.didEndSheetNotification, object: ownerWindow, queue: .main
            ) { [weak self] _ in
              MainActor.assumeIsolated {
                self?.popupOpen = false
                self?.refreshContent()
              }
            },
          ]
        }
      }
      if hosting == nil {
        let hosting = NSHostingView(rootView: AnyView(EmptyView()))
        let panel = NSPanel(
          contentRect: NSRect(x: 0, y: 0, width: WorkspaceDetail.inspectorWidth, height: 800),
          styleMask: [.titled, .resizable, .utilityWindow, .nonactivatingPanel, .fullSizeContentView],
          backing: .buffered, defer: false)
        panel.title = "Stim Tutorial"
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.isMovableByWindowBackground = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.fullScreenAuxiliary]
        panel.contentMinSize = NSSize(width: WorkspaceDetail.inspectorWidth, height: 420)
        panel.contentView = hosting
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
          panel.standardWindowButton(button)?.isHidden = true
        }
        if let screen = (ownerWindow?.screen ?? NSScreen.main)?.visibleFrame {
          let width = panel.frame.width
          let height = min(800, screen.height)
          let ownerFrame = ownerWindow?.frame ?? screen
          let right = ownerFrame.maxX + 12
          let left = ownerFrame.minX - width - 12
          let preferredX = right + width <= screen.maxX ? right : left
          let x = max(screen.minX, min(preferredX, screen.maxX - width))
          let y = max(screen.minY, min(ownerFrame.maxY - height, screen.maxY - height))
          panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: false)
        }
        self.panel = panel
        self.hosting = hosting
      }
      refreshContent()
      panel?.isFloatingPanel = false
      panel?.level = ownerWindow?.level ?? .normal
      if let panel, let ownerWindow, panel.parent !== ownerWindow {
        panel.parent?.removeChildWindow(panel)
        ownerWindow.addChildWindow(panel, ordered: .above)
      }
      if panel?.isVisible == false { panel?.orderFront(nil) }
    }

    private func refreshContent() {
      hosting?.rootView = AnyView(content.disabled(popupOpen).allowsHitTesting(!popupOpen))
    }

    func close() {
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
      observers = []
      owner = nil
      popupOpen = false
      content = AnyView(EmptyView())
      if let panel {
        panel.parent?.removeChildWindow(panel)
        panel.orderOut(nil)
      }
      panel = nil
      hosting = nil
    }

  }
}
