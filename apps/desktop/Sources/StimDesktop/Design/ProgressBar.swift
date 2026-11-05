import SwiftUI

/// A native linear progress bar; `nil` displays indeterminate progress.
struct StimProgressBar: View {
  var value: Double?
  var tint: Color = Palette.accent

  var body: some View {
    Group {
      if let value {
        ProgressView(value: value)
      } else {
        ProgressView().progressViewStyle(.linear)
      }
    }
    .tint(tint)
  }
}
