import SwiftUI

/// A short empty-list message in tertiary color, inheriting its container's font and insets.
struct InlineEmpty: View {
  let text: LocalizedStringKey

  init(_ text: LocalizedStringKey) {
    self.text = text
  }

  var body: some View {
    Text(text).foregroundStyle(Palette.tertiary)
  }
}
