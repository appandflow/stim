#if DEBUG
  import StimKit
  import SwiftUI

  struct NotificationCardsGallery: View {
    @StateObject private var center = ToastCenter(voiceOver: false)
    @StateObject private var notices = NoticeCenter()
    @State private var reduceMotion = false

    var body: some View {
      VStack(alignment: .leading) {
        HStack {
          Button("Show Sample Cards") {
            for title in [
              "Build approval requested", "Simulator unavailable", "Workspace needs attention",
              "Build finished", "Another build approval requested",
            ] {
              center.show(Toast(icon: "bell", title: title, body: "A sample notification for this workspace.", sticky: true))
            }
          }
          .buttonStyle(.stim())
          Button("Show Workspace Cards") {
            for name in ["short", "liquid-glass-custom-header-with-a-long-workspace-name"] {
              let path = "/workspace/\(name)"
              notices.show(
                Notice(
                  icon: "plus.rectangle.on.folder", title: "New workspace \(name)", detail: path,
                  actionTitle: "Show", perform: {}, key: WorkspaceArrivals.cardKey(path), workspacePath: path))
            }
          }
          .buttonStyle(.stim())
          Button("Show Four Workspace Cards") {
            for name in ["fp-rethink", "share-quest-opens-result-sheet", "fix-login", "add-dark-mode"] {
              let path = "/workspace/\(name)"
              notices.show(
                Notice(
                  icon: "plus.rectangle.on.folder", title: "New workspace \(name)", detail: path,
                  actionTitle: "Show", perform: {}, key: WorkspaceArrivals.cardKey(path), workspacePath: path))
            }
          }
          .buttonStyle(.stim())
          Toggle("Reduce Motion", isOn: $reduceMotion)
        }
        Spacer()
      }
      .padding(Space.xl)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .overlay(alignment: .topTrailing) {
        ToastStack(center: center, reduceMotionOverride: reduceMotion, onDismissAll: dismissAll)
      }
      .overlay(alignment: .bottomLeading) { NoticeStack(center: notices, onDismissAll: dismissAll) }
    }

    private func dismissAll() {
      center.dismissAll()
      notices.dismissAll()
    }
  }
#endif
