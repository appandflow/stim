import SwiftUI

/// A borderless icon button that shows a raised fill on hover or while `active`, for the sidebar footer and headers.
struct IconButtonStyle: ButtonStyle {
  var tint: Color = Palette.secondary
  var active = false

  func makeBody(configuration: Configuration) -> some View {
    IconButtonBody(configuration: configuration, tint: tint, active: active)
  }
}

extension ButtonStyle where Self == IconButtonStyle {
  static func icon(tint: Color = Palette.secondary, active: Bool = false) -> IconButtonStyle {
    IconButtonStyle(tint: tint, active: active)
  }
}

private struct IconButtonBody: View {
  var configuration: ButtonStyleConfiguration
  var tint: Color
  var active: Bool
  @Environment(\.isEnabled) private var isEnabled
  @State private var hovering = false

  var body: some View {
    configuration.label
      .foregroundStyle(tint)
      .frame(minWidth: 26, minHeight: 24)
      .background(RoundedRectangle(cornerRadius: Radius.chip).fill(hovering || active ? Palette.raised : .clear))
      .contentShape(Rectangle())
      .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : Opacity.disabled)
      .onHover { hovering = $0 }
  }
}

/// An SF Symbol button with an optional short count after the icon, such as the number of agent-driven devices.
struct IconButton: View {
  var systemImage: String
  var tint = Palette.secondary
  var badge: String?
  var help: String
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: Space.xxs) {
        Image(systemName: systemImage).font(.system(size: 12, weight: .medium))
        if let badge { Text(badge).textStyle(.caption2, weight: .medium) }
      }
      .padding(.horizontal, badge == nil ? 0 : Space.sm)
    }
    .buttonStyle(.icon(tint: tint))
    .help(help)
  }
}
