import SwiftUI

extension View {
  /// SwiftUI reports a lazy container with no realized children, such as one scrolled out of view, as an
  /// accessibility element at (inf, inf, 0, 0), which tools that read the tree cannot encode. Exposing the
  /// container as a group gives it its laid-out frame.
  func finiteAccessibilityFrame() -> some View {
    accessibilityElement(children: .contain)
  }
}
