import AppKit
import StimKit
import SwiftUI

/// A card at the main window's top right corner; clicking it runs its action.
struct Toast: Identifiable {
  struct Action {
    var title: String
    var perform: @MainActor () -> Void
  }

  let id = UUID()
  var icon: String
  var tone: Tone = .neutral
  var title: String
  var body: String?
  var action: Action?
  /// A sticky toast stays until the user acts on it or dismisses it; any other one leaves after
  /// `ToastCenter.lifetime`, unless the pointer is over it, its action holds keyboard focus, or VoiceOver is running.
  var sticky = false
  /// Showing a toast replaces any shown one with the same key.
  var key: String?
}

@MainActor
final class ToastCenter: ObservableObject {
  static let shared = ToastCenter()
  static let lifetime: TimeInterval = 6
  static let maxVisible = 4

  @Published private(set) var toasts: [Toast] = []
  private var timers: [Toast.ID: Timer] = [:]
  private var holds: [Toast.ID: Set<Hold>] = [:]

  enum Hold {
    case pointer
    case focus
  }

  func show(_ toast: Toast) {
    if let key = toast.key {
      for old in toasts where old.key == key { timers.removeValue(forKey: old.id)?.invalidate() }
      toasts.removeAll { $0.key == key }
    }
    toasts.insert(toast, at: 0)
    schedule(toast)
    announce(toast)
  }

  private func announce(_ toast: Toast) {
    guard NSWorkspace.shared.isVoiceOverEnabled else { return }
    let text = [toast.title, toast.body, toast.action.map { "Action: \($0.title)" }].compactMap { $0 }
      .joined(separator: ". ")
    NSAccessibility.post(
      element: NSApp as Any, notification: .announcementRequested,
      userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
  }

  func release(_ id: Toast.ID) {
    holds.removeValue(forKey: id)
    if let toast = toasts.first(where: { $0.id == id }) { schedule(toast) }
  }

  func dismiss(_ id: Toast.ID) {
    timers.removeValue(forKey: id)?.invalidate()
    holds.removeValue(forKey: id)
    toasts.removeAll { $0.id == id }
  }

  func dismiss(key: String) {
    for toast in toasts where toast.key == key { dismiss(toast.id) }
  }

  func hold(_ id: Toast.ID, _ hold: Hold, _ on: Bool) {
    if on {
      holds[id, default: []].insert(hold)
      timers.removeValue(forKey: id)?.invalidate()
    } else {
      holds[id]?.remove(hold)
      if let toast = toasts.first(where: { $0.id == id }) { schedule(toast) }
    }
  }

  private func schedule(_ toast: Toast) {
    guard !toast.sticky, holds[toast.id]?.isEmpty ?? true, !NSWorkspace.shared.isVoiceOverEnabled else { return }
    let id = toast.id
    timers[id]?.invalidate()
    timers[id] = Timer.scheduledTimer(withTimeInterval: Self.lifetime, repeats: false) { _ in
      MainActor.assumeIsolated { ToastCenter.shared.dismiss(id) }
    }
  }
}

struct ToastStack: View {
  static let topInset: CGFloat = 56
  @ObservedObject var center: ToastCenter
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .trailing, spacing: Space.md) {
      ForEach(center.toasts.prefix(ToastCenter.maxVisible)) { toast in
        ToastCard(toast: toast, center: center).transition(
          reduceMotion ? .opacity : .move(edge: .trailing).combined(with: .opacity))
      }
      if center.toasts.count > ToastCenter.maxVisible {
        Text("\(center.toasts.count - ToastCenter.maxVisible) more")
          .textStyle(.caption, weight: .semibold)
          .foregroundStyle(Palette.secondary)
          .padding(.horizontal, Space.md)
          .padding(.vertical, Space.xs)
          .background(Capsule().fill(.regularMaterial))
      }
    }
    .frame(width: 360)
    .padding(.horizontal, Space.xl)
    .padding(.top, Self.topInset)
    .animation(.easeOut(duration: 0.2), value: center.toasts.map(\.id))
  }
}

private struct ToastCard: View {
  var toast: Toast
  @ObservedObject var center: ToastCenter
  @FocusState private var actionFocused: Bool

  var body: some View {
    Banner(tone: toast.tone, icon: toast.icon, style: .floating, onDismiss: { center.dismiss(toast.id) }) {
      Text(toast.title).font(.stim(.headline)).lineLimit(2)
      if let body = toast.body {
        Text(body).foregroundStyle(Palette.secondary).lineLimit(3).truncationMode(.middle)
      }
      if let action = toast.action {
        Button(action.title) {
          center.dismiss(toast.id)
          action.perform()
        }
        .buttonStyle(.stim(.primary))
        .focused($actionFocused)
        .padding(.top, Space.xxs)
      }
    }
    .contentShape(Rectangle())
    .onTapGesture {
      guard let action = toast.action else { return }
      center.dismiss(toast.id)
      action.perform()
    }
    .onHover { center.hold(toast.id, .pointer, $0) }
    .onDisappear { center.release(toast.id) }
    .onChange(of: actionFocused) { _, focused in center.hold(toast.id, .focus, focused) }
  }
}
