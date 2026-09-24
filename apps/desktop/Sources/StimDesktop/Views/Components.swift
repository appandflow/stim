import SwiftUI

struct StatusDot: View {
  var color: Color
  var filled = true

  var body: some View {
    Circle()
      .fill(filled ? color : .clear)
      .overlay(Circle().strokeBorder(filled ? .clear : color, lineWidth: 1))
      .frame(width: 7, height: 7)
  }
}

struct Chip<Content: View>: View {
  var tint: Color?
  @ViewBuilder var content: Content

  var body: some View {
    HStack(spacing: 6) { content }
      .font(Theme.body(11.5))
      .foregroundStyle(tint ?? Theme.secondary)
      .padding(.horizontal, 9)
      .padding(.vertical, 4)
      .background(RoundedRectangle(cornerRadius: 7).fill(tint?.opacity(0.16) ?? Theme.surface))
  }
}

struct SectionLabel: View {
  var title: String

  var body: some View {
    Text(title.uppercased())
      .font(Theme.body(10.5, weight: .semibold))
      .tracking(0.6)
      .foregroundStyle(Theme.tertiary)
  }
}

struct Card<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    content
      .background(RoundedRectangle(cornerRadius: 12).fill(Theme.surface))
      .clipShape(RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.border))
  }
}

struct EmptyState: View {
  var title: String
  var message: String
  var showsHero = false

  var body: some View {
    VStack(spacing: 14) {
      if showsHero, let hero = BrandAssets.hero {
        Image(nsImage: hero)
          .resizable()
          .scaledToFit()
          .frame(width: 220, height: 220)
          .clipShape(RoundedRectangle(cornerRadius: 24))
      }
      Text(title).font(Theme.heading(17))
      Text(message).foregroundStyle(Theme.secondary).multilineTextAlignment(.center)
    }
    .padding(40)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct CommandText: View {
  var command: String

  var body: some View {
    Text(command)
      .font(Theme.mono())
      .foregroundStyle(Theme.secondary)
      .padding(.horizontal, 8)
      .padding(.vertical, 5)
      .background(RoundedRectangle(cornerRadius: 6).fill(Theme.background))
      .textSelection(.enabled)
  }
}
