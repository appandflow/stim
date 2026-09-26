import SwiftUI

enum PillTone: CaseIterable {
  case neutral
  case accent
  case success
  case warning
  case error
  case info

  var color: Color {
    switch self {
    case .neutral: return Palette.secondary
    case .accent: return Palette.primary
    case .success: return Palette.success
    case .warning: return Palette.warning
    case .error: return Palette.error
    case .info: return Palette.info
    }
  }
}

/// A short label on a tinted background. `regular` is a rounded chip for header facts and filters; `small` is a
/// capsule badge beside a title or count. An `outlined` pill has no fill and a neutral border, for a filter that is off.
struct Pill<Content: View>: View {
  enum Size: CaseIterable {
    case small
    case regular
  }

  var tone: PillTone = .neutral
  var size: Size = .regular
  var outlined = false
  @ViewBuilder var content: Content

  var body: some View {
    HStack(spacing: size == .small ? Space.xs : Space.sm) { content }
      .textStyle(size == .small ? .caption2 : .footnote, weight: size == .small ? .semibold : nil)
      .foregroundStyle(outlined ? Palette.tertiary : tone.color)
      .lineLimit(1)
      .padding(.horizontal, size == .small ? Space.sm : Space.md)
      .padding(.vertical, size == .small ? Space.xxs : Space.xs)
      .background(shape.fill(fill))
      .overlay(shape.strokeBorder(outlined ? Palette.border : .clear))
      .fixedSize()
  }

  private var shape: RoundedRectangle {
    RoundedRectangle(cornerRadius: size == .small ? Radius.round : Radius.chip)
  }

  private var fill: Color {
    if outlined { return .clear }
    return tone == .neutral ? Palette.surface : tone.color.opacity(Opacity.tint)
  }
}

extension Pill where Content == Text {
  init(_ title: String, tone: PillTone = .neutral, size: Size = .regular) {
    self.init(tone: tone, size: size) { Text(title) }
  }
}
