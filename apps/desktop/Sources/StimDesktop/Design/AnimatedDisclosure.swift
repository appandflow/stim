import SwiftUI

struct AnimatedDisclosure<Header: View, Content: View>: View {
  var isExpanded: Bool
  @ViewBuilder var header: Header
  @ViewBuilder var content: Content
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      header
      if isExpanded { content.transition(.opacity) }
    }
    .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: isExpanded)
  }
}
