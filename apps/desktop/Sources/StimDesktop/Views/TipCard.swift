import StimKit
import SwiftUI

struct TipCard: View {
  var topic: TipTopic
  var hasNext: Bool
  var perform: () -> Void
  var next: () -> Void
  var close: () -> Void

  var body: some View {
    Banner(tone: .accent, icon: "lightbulb", onDismiss: close) {
      Text("Tip").textStyle(.caption, weight: .semibold).foregroundStyle(Palette.secondary)
      Text(topic.title).font(.stim(.headline)).fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .leading, spacing: Space.xs) {
        Button(topic.actionTitle, action: perform).buttonStyle(.stim(.primary, .small))
        if hasNext { Button("Next Tip", action: next).buttonStyle(.stim(.plain, .small)) }
      }
      .padding(.top, Space.xxs)
    }
    .accessibilityElement(children: .contain)
  }
}
