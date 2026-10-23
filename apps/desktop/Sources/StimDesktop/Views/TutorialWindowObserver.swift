import AppKit
import SwiftUI

struct TutorialWindowObserver: NSViewRepresentable {
  @Binding var isFullScreen: Bool
  @Binding var popupOpen: Bool

  func makeNSView(context: Context) -> ObserverView {
    let view = ObserverView()
    updateNSView(view, context: context)
    return view
  }

  func updateNSView(_ view: ObserverView, context: Context) {
    view.changed = { fullScreen, sheetOpen in
      if isFullScreen != fullScreen { isFullScreen = fullScreen }
      if popupOpen != sheetOpen { popupOpen = sheetOpen }
    }
  }

  static func dismantleNSView(_ view: ObserverView, coordinator: ()) {
    view.stop()
  }

  @MainActor final class ObserverView: NSView {
    var changed: ((Bool, Bool) -> Void)?
    private var observers: [NSObjectProtocol] = []
    private var delivery: Task<Void, Never>?

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      stop()
      guard let window else { return }
      for name in [NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification] {
        observers.append(
          NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.publish() }
          })
      }
      for name in [NSWindow.willBeginSheetNotification, NSWindow.didEndSheetNotification] {
        observers.append(
          NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] event in
            MainActor.assumeIsolated {
              self?.publish(sheetOpen: event.name == NSWindow.willBeginSheetNotification)
            }
          })
      }
      publish()
    }

    private func publish(sheetOpen: Bool? = nil) {
      guard let window else { return }
      let fullScreen = window.styleMask.contains(.fullScreen)
      let sheetOpen = sheetOpen ?? (window.attachedSheet != nil)
      delivery?.cancel()
      delivery = Task { @MainActor [weak self] in
        guard !Task.isCancelled else { return }
        self?.changed?(fullScreen, sheetOpen)
      }
    }

    func stop() {
      delivery?.cancel()
      delivery = nil
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
      observers = []
    }
  }
}
