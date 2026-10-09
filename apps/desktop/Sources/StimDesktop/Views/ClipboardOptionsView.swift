import StimKit
import SwiftUI

/// The clipboard section of a device's options popover: the sync switch and the two manual transfers.
struct ClipboardOptionsView: View {
  @AppStorage(AppPreferences.Key.syncsClipboard) private var syncs = true
  var paste: () -> Void
  var copy: () async -> Bool

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Toggle("Sync clipboard", isOn: $syncs)
        .help("Copy text between this Mac and the device while this window is focused")
      HStack(spacing: Space.sm) {
        Button("Paste Mac Clipboard", action: paste)
          .buttonStyle(.stim(.secondary))
          .help("Paste the Mac clipboard's text into the focused device field")
        CopyButton(
          variant: .secondary, title: "Copy Device Clipboard", help: "Replace the Mac clipboard with the device clipboard's text",
          copy: copy)
      }
      .controlSize(.small)
    }
  }
}

/// The options popover of an Android emulator, or of a simulator without Control: the clipboard section when there is
/// one and the device frame choice.
struct EmulatorOptionsView: View {
  var title = "Emulator options"
  var clipboard: ClipboardOptionsView?
  var frame: DeviceFrameOption?

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      Text(title).font(.stim(.headline))
      if let frame { DeviceFrameToggle(frame: frame) }
      if frame != nil, clipboard != nil { Divider() }
      if let clipboard { clipboard }
    }
    .font(.stim(.callout))
    .controlSize(.small)
    .frame(width: 300)
    .padding(Space.lg)
  }
}

/// Reports whether the window holding this view is key, visible without being key, or hidden.
struct WindowStateReader: NSViewRepresentable {
  var onChange: (ClipboardSync.WindowState) -> Void

  func makeNSView(context: Context) -> WindowStateView {
    let view = WindowStateView()
    view.onChange = onChange
    return view
  }

  func updateNSView(_ view: WindowStateView, context: Context) { view.onChange = onChange }
}

final class WindowStateView: NSView {
  var onChange: (ClipboardSync.WindowState) -> Void = { _ in }
  private var observers: [NSObjectProtocol] = []

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    guard let window else {
      report(nil)
      return
    }
    let names: [Notification.Name] = [
      NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification, NSWindow.didChangeOcclusionStateNotification,
      NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification,
    ]
    observers = names.map { name in
      NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
        self?.report(window)
      }
    }
    report(window)
  }

  deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

  private func report(_ window: NSWindow?) {
    let state: ClipboardSync.WindowState
    if let window, window.isVisible, !window.isMiniaturized, window.occlusionState.contains(.visible) {
      state = window.isKeyWindow ? .key : .visible
    } else {
      state = .hidden
    }
    DispatchQueue.main.async { [weak self] in self?.onChange(state) }
  }
}
