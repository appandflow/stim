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

  var body: some View {
    configuration.label
      .foregroundStyle(tint)
      .frame(minWidth: 26, minHeight: 24)
      .hoverHighlight(selected: active)
      .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : Opacity.disabled)
  }
}

/// An SF Symbol button with an optional short count after the icon, such as the number of agent-driven devices.
/// `help` is the tooltip; `label` is the accessibility label, by default `help`'s first line up to " \u{2014} ".
struct IconButton: View {
  var systemImage: String
  var tint = Palette.secondary
  var badge: String?
  var help: String
  var label: String?
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
    .accessibilityLabel(
      label ?? String(help.prefix { $0 != "\n" }).components(separatedBy: " \u{2014} ")[0])
  }
}
