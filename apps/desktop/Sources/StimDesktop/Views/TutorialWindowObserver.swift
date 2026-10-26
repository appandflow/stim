import AppKit
import QuartzCore
import SwiftUI

struct TutorialWindowObserver: NSViewRepresentable {
  @Binding var isFullScreen: Bool
  @Binding var popupOpen: Bool
  @Binding var transitioning: Bool

  func makeNSView(context: Context) -> ObserverView {
    let view = ObserverView()
    updateNSView(view, context: context)
    return view
  }

  func updateNSView(_ view: ObserverView, context: Context) {
    view.changed = { fullScreen, sheetOpen, inTransition in
      if isFullScreen != fullScreen { isFullScreen = fullScreen }
      if popupOpen != sheetOpen { popupOpen = sheetOpen }
      if transitioning != inTransition { transitioning = inTransition }
    }
  }

  static func dismantleNSView(_ view: ObserverView, coordinator: ()) {
    view.stop()
  }

  @MainActor final class ObserverView: NSView {
    var changed: ((Bool, Bool, Bool) -> Void)?
    private var transitioning = false
    private var settledFullScreen = false
    private var observers: [NSObjectProtocol] = []
    private var delivery: Task<Void, Never>?
    private var transitionRecovery: Task<Void, Never>?

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      stop()
      guard let window else { return }
      settledFullScreen = window.styleMask.contains(.fullScreen)
      for name in [
        NSWindow.willEnterFullScreenNotification, NSWindow.willExitFullScreenNotification,
        NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification,
      ] {
        observers.append(
          NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self, weak window] event in
            MainActor.assumeIsolated {
              guard let self, let window else { return }
              self.transitioning =
                event.name == NSWindow.willEnterFullScreenNotification
                || event.name == NSWindow.willExitFullScreenNotification
              self.transitionRecovery?.cancel()
              if self.transitioning {
                self.settledFullScreen = event.name == NSWindow.willEnterFullScreenNotification
                self.transitionRecovery = Task { @MainActor [weak self, weak window] in
                  try? await Task.sleep(for: .seconds(5))
                  guard !Task.isCancelled, let self, let window else { return }
                  self.transitioning = false
                  self.settledFullScreen = window.styleMask.contains(.fullScreen)
                  self.publish()
                }
              } else {
                self.settledFullScreen = window.styleMask.contains(.fullScreen)
              }
              self.publish()
            }
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
      let fullScreen = settledFullScreen
      let transitioning = transitioning
      let sheetOpen = sheetOpen ?? (window.attachedSheet != nil)
      delivery?.cancel()
      delivery = Task { @MainActor [weak self] in
        guard !Task.isCancelled else { return }
        self?.changed?(fullScreen, sheetOpen, transitioning)
      }
    }

    func stop() {
      transitioning = false
      transitionRecovery?.cancel()
      transitionRecovery = nil
      delivery?.cancel()
      delivery = nil
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
      observers = []
    }
  }
}

struct TutorialDockHost<Content: View>: NSViewRepresentable {
  var transitioning: Bool
  @ViewBuilder var content: () -> Content

  func makeNSView(context: Context) -> Host {
    let view = Host(rootView: content())
    view.isHidden = transitioning
    return view
  }

  func updateNSView(_ view: Host, context: Context) {
    view.rootView = content()
    view.setTransitioning(transitioning)
  }

  static func dismantleNSView(_ view: Host, coordinator: ()) {
    view.stop()
  }

  final class Host: NSHostingView<Content> {
    private var observers: [NSObjectProtocol] = []

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      stop()
      guard let window else { return }
      for name in [
        NSWindow.willEnterFullScreenNotification, NSWindow.willExitFullScreenNotification,
      ] {
        observers.append(
          NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
              guard let self else { return }
              self.setTransitioning(true)
              self.superview?.displayIfNeeded()
              CATransaction.flush()
            }
          })
      }
    }

    func setTransitioning(_ transitioning: Bool) {
      if transitioning {
        isHidden = true
        alphaValue = 0
      } else if isHidden {
        alphaValue = 0
        isHidden = false
        NSAnimationContext.runAnimationGroup { context in
          context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.2
          context.timingFunction = CAMediaTimingFunction(name: .easeOut)
          animator().alphaValue = 1
        }
      }
    }

    func stop() {
      for observer in observers { NotificationCenter.default.removeObserver(observer) }
      observers = []
    }
  }
}
