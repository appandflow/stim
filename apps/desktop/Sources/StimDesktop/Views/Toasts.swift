import SwiftUI

struct Toast: Identifiable {
  struct Action {
    var title: String
    var perform: @MainActor () -> Void
  }

  let id = UUID()
  var icon: String
  var tone: BannerTone = .neutral
  var title: String
  var body: String?
  var action: Action?
  /// A sticky toast stays until the user acts on it or dismisses it; any other one leaves after a few seconds.
  var sticky = false
  /// Showing a toast replaces any shown one with the same key.
  var key: String?
}

@MainActor
final class ToastCenter: ObservableObject {
  static let shared = ToastCenter()
  static let lifetime: Duration = .seconds(6)

  @Published private(set) var toasts: [Toast] = []

  func show(_ toast: Toast) {
    if let key = toast.key { toasts.removeAll { $0.key == key } }
    toasts.append(toast)
    guard !toast.sticky else { return }
    Task {
      try? await Task.sleep(for: Self.lifetime)
      dismiss(toast.id)
    }
  }

  func dismiss(_ id: Toast.ID) {
    toasts.removeAll { $0.id == id }
  }
}

struct ToastStack: View {
  @ObservedObject var center: ToastCenter

  var body: some View {
    VStack(alignment: .trailing, spacing: Space.md) {
      ForEach(center.toasts) { toast in
        card(toast).transition(.move(edge: .trailing).combined(with: .opacity))
      }
    }
    .frame(width: 360)
    .padding(Space.xl)
    .animation(.easeOut(duration: 0.2), value: center.toasts.map(\.id))
  }

  private func card(_ toast: Toast) -> some View {
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
        .padding(.top, Space.xxs)
      }
    }
  }
}
