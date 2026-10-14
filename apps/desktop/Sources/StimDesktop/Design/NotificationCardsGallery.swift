#if DEBUG
  import SwiftUI

  struct NotificationCardsGallery: View {
    @StateObject private var center = ToastCenter(voiceOver: false)
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
          Toggle("Reduce Motion", isOn: $reduceMotion)
        }
        Spacer()
      }
      .padding(Space.xl)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .overlay(alignment: .topTrailing) {
        ToastStack(center: center, reduceMotionOverride: reduceMotion)
      }
    }
  }
#endif
