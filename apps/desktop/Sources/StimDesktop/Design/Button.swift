import SwiftUI

enum ButtonVariant: CaseIterable {
  case primary
  case secondary
  case plain
  case destructive
}

enum ButtonSize: CaseIterable {
  case small
  case regular

  fileprivate var height: CGFloat { self == .small ? 24 : 28 }
  fileprivate var horizontalPadding: CGFloat { self == .small ? Space.md + Space.xxs : Space.lg }
  fileprivate var textStyle: TextVariant { self == .small ? .footnote : .callout }
}

/// Stim's text button for custom surfaces: a solid brand fill for `primary`, an accent tint for `secondary`,
/// no fill until hovered for `plain`, and a red tint for `destructive`.
struct StimButtonStyle: ButtonStyle {
  var variant: ButtonVariant = .secondary
  var size: ButtonSize = .small

  func makeBody(configuration: Configuration) -> some View {
    StimButtonBody(configuration: configuration, variant: variant, size: size)
  }
}

extension ButtonStyle where Self == StimButtonStyle {
  static func stim(_ variant: ButtonVariant = .secondary, _ size: ButtonSize = .small) -> StimButtonStyle {
    StimButtonStyle(variant: variant, size: size)
  }
}

private struct StimButtonBody: View {
  var configuration: ButtonStyleConfiguration
  var variant: ButtonVariant
  var size: ButtonSize
  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.isFocused) private var isFocused
  @State private var hovering = false

  var body: some View {
    configuration.label
      .textStyle(size.textStyle, weight: .semibold)
      .foregroundStyle(foreground)
      .padding(.horizontal, size.horizontalPadding)
      .frame(height: size.height)
      .background(Capsule().fill(fill))
      .overlay(Capsule().strokeBorder(Palette.accent.opacity(isFocused ? 0.8 : 0), lineWidth: 2))
      .contentShape(Capsule())
      .opacity(isEnabled ? 1 : Opacity.disabled)
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
      .animation(.easeOut(duration: 0.1), value: hovering)
      .onHover { hovering = $0 }
  }

  private var accent: Color {
    switch variant {
    case .primary: return Palette.brand
    case .secondary, .plain: return Palette.accent
    case .destructive: return Palette.error
    }
  }

  private var foreground: Color { variant == .primary ? Palette.onBrand : accent }

  private var fill: Color {
    switch variant {
    case .primary:
      return accent.opacity(configuration.isPressed ? 0.8 : hovering ? 1 : 0.92)
    case .secondary, .destructive:
      return accent.opacity(configuration.isPressed ? 0.22 : hovering ? 0.17 : 0.11)
    case .plain:
      return accent.opacity(configuration.isPressed ? 0.17 : hovering ? 0.11 : 0)
    }
  }
}
