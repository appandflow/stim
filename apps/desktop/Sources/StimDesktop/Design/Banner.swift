import SwiftUI

enum BannerTone: CaseIterable {
  case neutral
  case accent
  case warning
  case error

  var color: Color {
    switch self {
    case .neutral: return Palette.secondary
    case .accent: return Palette.accent
    case .warning: return Palette.warning
    case .error: return Palette.error
    }
  }
}

/// A status message with an icon. `inline` sits in the content as a card tinted in the tone's color; `floating`
/// is a material card with a shadow, for a toast over the content. `trailing` holds actions beside the text.
struct Banner<Content: View, Trailing: View>: View {
  enum Style: CaseIterable {
    case inline
    case floating
  }

  var tone: BannerTone = .neutral
  var icon: String
  var style: Style = .inline
  var onDismiss: (() -> Void)?
  @ViewBuilder var content: Content
  @ViewBuilder var trailing: Trailing

  var body: some View {
    HStack(alignment: .top, spacing: Space.lg) {
      Image(systemName: icon).font(.system(size: 18)).foregroundStyle(tone.color).frame(width: 22)
      VStack(alignment: .leading, spacing: Space.sm) { content }
        .frame(maxWidth: .infinity, alignment: .leading)
      trailing
      if let onDismiss {
        Button(action: onDismiss) {
          Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.tertiary)
        }
        .buttonStyle(.plain)
        .help("Dismiss")
      }
    }
    .padding(style == .inline ? Space.xl : Space.lg + Space.xxs)
    .background(background)
    .overlay(
      RoundedRectangle(cornerRadius: Radius.card).strokeBorder(style == .inline ? tone.color.opacity(0.35) : Palette.border)
    )
    .shadow(color: .black.opacity(style == .floating ? 0.28 : 0), radius: 20, y: 6)
  }

  @ViewBuilder private var background: some View {
    switch style {
    case .inline: RoundedRectangle(cornerRadius: Radius.card).fill(tone.color.opacity(Opacity.pressed))
    case .floating: RoundedRectangle(cornerRadius: Radius.card).fill(.regularMaterial)
    }
  }
}

extension Banner where Trailing == EmptyView {
  init(
    tone: BannerTone = .neutral, icon: String, style: Style = .inline, onDismiss: (() -> Void)? = nil,
    @ViewBuilder content: () -> Content
  ) {
    self.init(tone: tone, icon: icon, style: style, onDismiss: onDismiss, content: content) { EmptyView() }
  }
}
