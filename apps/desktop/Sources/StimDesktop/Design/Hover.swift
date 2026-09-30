import SwiftUI

/// The fill under a sidebar list row: `Palette.selection` while `selected`, otherwise the hover tint.
struct HoverFill: View {
  var radius: CGFloat = Radius.chip
  var hovering: Bool
  var selected = false

  var body: some View {
    RoundedRectangle(cornerRadius: radius).fill(selected ? Palette.selection : HoverTint.color(hovering: hovering))
  }
}

private enum HoverTint {
  static func color(hovering: Bool, pressed: Bool = false, dark: Bool = true) -> Color {
    let weight = dark ? 1.0 : 0.5
    if pressed { return Palette.accent.opacity(Opacity.tint * weight) }
    return Palette.accent.opacity(hovering ? Opacity.subtle * weight : 0)
  }
}

/// Draws `Palette.selection` behind a selected view and the hover or pressed tint over any view, so the tint
/// also shows on labels that paint their own background. Light `Palette.selection` is a faint accent tint, so a
/// light hover stays under it.
private struct HoverLayers: ViewModifier {
  var radius: CGFloat
  var outset: CGFloat
  var hovering: Bool
  var pressed: Bool
  var selected: Bool
  @Environment(\.colorScheme) private var scheme

  func body(content: Content) -> some View {
    content
      .background {
        if selected { RoundedRectangle(cornerRadius: radius).fill(Palette.selection).padding(-outset) }
      }
      .overlay {
        RoundedRectangle(cornerRadius: radius)
          .fill(
            selected
              ? Color.clear : HoverTint.color(hovering: hovering, pressed: pressed, dark: scheme == .dark)
          )
          .padding(-outset)
          .allowsHitTesting(false)
          .animation(.easeOut(duration: 0.1), value: hovering)
          .animation(.easeOut(duration: 0.1), value: pressed)
      }
  }
}

/// A plain button that shows the shared hover tint: the style for rows, chips and text links. The label carries
/// its own padding so the tint covers it; `outset` grows the tint past a tight label without changing layout.
/// A selected button shows `Palette.selection` and no hover; a disabled one shows no hover.
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
      .modifier(
        HoverLayers(
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
      .modifier(
        HoverLayers(radius: radius, outset: outset, hovering: hovering && isEnabled, pressed: false, selected: selected)
      )
      .contentShape(Rectangle())
      .onHover { hovering = $0 }
  }
}

extension View {
  /// Adds the shared hover tint to a clickable view that is not a `Button`, such as a row with a tap gesture or
  /// a `Menu`. Use `.buttonStyle(.hoverRow())` on buttons.
  func hoverHighlight(radius: CGFloat = Radius.chip, outset: CGFloat = 0, selected: Bool = false) -> some View {
    modifier(HoverHighlight(radius: radius, outset: outset, selected: selected))
  }
}
