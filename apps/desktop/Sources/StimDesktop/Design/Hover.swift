import SwiftUI

/// The fill under a clickable row or chip: a light accent tint while the pointer is over it, a stronger one while
/// it is pressed, and `Palette.selection` while `selected`, which hovering does not change.
struct HoverFill: View {
  var radius: CGFloat = Radius.chip
  var outset: CGFloat = 0
  var hovering: Bool
  var pressed = false
  var selected = false
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    RoundedRectangle(cornerRadius: radius)
      .fill(color)
      .padding(-outset)
      .animation(.easeOut(duration: 0.1), value: hovering)
      .animation(.easeOut(duration: 0.1), value: pressed)
  }

  /// Light `Palette.selection` is itself a faint accent tint, so a light hover stays under it.
  private var color: Color {
    let weight = scheme == .dark ? 1.0 : 0.5
    if selected { return Palette.selection }
    if pressed { return Palette.accent.opacity(Opacity.tint * weight) }
    return Palette.accent.opacity(hovering ? Opacity.subtle * weight : 0)
  }
}

/// A plain button that shows the shared hover fill: the style for rows, chips and text links that have no
/// background of their own. The label carries its own padding so the fill covers it; `outset` grows the fill past
/// a tight label without changing layout. A disabled button shows no hover.
struct HoverRowStyle: ButtonStyle {
  var radius: CGFloat = Radius.chip
  var outset: CGFloat = 0
  var selected = false

  func makeBody(configuration: Configuration) -> some View {
    HoverRowBody(configuration: configuration, radius: radius, outset: outset, selected: selected)
  }
}

extension ButtonStyle where Self == HoverRowStyle {
  static func hoverRow(radius: CGFloat = Radius.chip, outset: CGFloat = 0, selected: Bool = false) -> HoverRowStyle {
    HoverRowStyle(radius: radius, outset: outset, selected: selected)
  }
}

private struct HoverRowBody: View {
  var configuration: ButtonStyleConfiguration
  var radius: CGFloat
  var outset: CGFloat
  var selected: Bool
  @Environment(\.isEnabled) private var isEnabled
  @State private var hovering = false

  var body: some View {
    configuration.label
      .background(
        HoverFill(
          radius: radius, outset: outset, hovering: hovering && isEnabled,
          pressed: configuration.isPressed && isEnabled, selected: selected)
      )
      .contentShape(Rectangle())
      .opacity(isEnabled ? 1 : Opacity.disabled)
      .onHover { hovering = $0 }
  }
}

private struct HoverHighlight: ViewModifier {
  var radius: CGFloat
  var outset: CGFloat
  var selected: Bool
  @Environment(\.isEnabled) private var isEnabled
  @State private var hovering = false

  func body(content: Content) -> some View {
    content
      .background(
        HoverFill(radius: radius, outset: outset, hovering: hovering && isEnabled, pressed: false, selected: selected)
      )
      .contentShape(Rectangle())
      .onHover { hovering = $0 }
  }
}

extension View {
  /// Adds the shared hover fill to a clickable view that is not a `Button`, such as a row with a tap gesture or
  /// a `Menu` label. Use `.buttonStyle(.hoverRow())` on buttons.
  func hoverHighlight(radius: CGFloat = Radius.chip, outset: CGFloat = 0, selected: Bool = false) -> some View {
    modifier(HoverHighlight(radius: radius, outset: outset, selected: selected))
  }
}
