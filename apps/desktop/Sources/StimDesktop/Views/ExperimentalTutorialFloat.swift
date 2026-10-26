import AppKit
import QuartzCore
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
    private var transitioning = false
    private var followsAppEdge = true

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
          observers.append(
            NotificationCenter.default.addObserver(
              forName: NSWindow.didResizeNotification, object: ownerWindow, queue: .main
            ) { [weak self] _ in
              MainActor.assumeIsolated {
                guard let self, self.followsAppEdge, !self.transitioning else { return }
                self.positionTutorialBesideApp()
              }
            })
          for name in [NSWindow.willEnterFullScreenNotification, NSWindow.willExitFullScreenNotification] {
            observers.append(
              NotificationCenter.default.addObserver(forName: name, object: ownerWindow, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                  self?.transitioning = true
                  self?.panel?.orderOut(nil)
                }
              })
          }
        }
      }
      if transitioning { return }
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
        self.panel = panel
        self.hosting = hosting
        if let screen = (ownerWindow?.screen ?? NSScreen.main)?.visibleFrame {
          panel.setContentSize(NSSize(width: WorkspaceDetail.inspectorWidth, height: min(800, screen.height)))
        }
        positionTutorialBesideApp()
        observers.append(
          NotificationCenter.default.addObserver(
            forName: NSWindow.willMoveNotification, object: panel, queue: .main
          ) { [weak self] _ in
            MainActor.assumeIsolated { self?.followsAppEdge = false }
          })
      }
      refreshContent()
      panel?.isFloatingPanel = false
      panel?.level = ownerWindow?.level ?? .normal
      if let panel, let ownerWindow, panel.parent !== ownerWindow {
        panel.parent?.removeChildWindow(panel)
        ownerWindow.addChildWindow(panel, ordered: .above)
      }
      if let panel, !panel.isVisible {
        panel.alphaValue = 0
        panel.orderFront(nil)
        NSAnimationContext.runAnimationGroup { context in
          context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.2
          context.timingFunction = CAMediaTimingFunction(name: .easeOut)
          panel.animator().alphaValue = 1
        }
      }
    }

    private func positionTutorialBesideApp() {
      guard let panel, let owner, let screen = owner.screen?.visibleFrame else { return }
      let width = panel.frame.width
      let height = panel.frame.height
      let right = owner.frame.maxX + 12
      let left = owner.frame.minX - width - 12
      let preferredX = right + width <= screen.maxX ? right : left
      let x = max(screen.minX, min(preferredX, screen.maxX - width))
      let y = max(screen.minY, min(owner.frame.maxY - height, screen.maxY - height))
      panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    private func refreshContent() {
      hosting?.rootView = AnyView(content.disabled(popupOpen).allowsHitTesting(!popupOpen))
    }

    func close() {
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
      observers = []
      owner = nil
      popupOpen = false
      transitioning = false
      followsAppEdge = true
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
