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

struct Sparkline: View {
  var values: [Double]
  var color: Color = Theme.lavender
  var minimumPeak: Double = 1

  var body: some View {
    GeometryReader { geo in
      let peak = max(values.max() ?? 0, minimumPeak)
      let step = values.count > 1 ? geo.size.width / CGFloat(values.count - 1) : 0
      let points = values.enumerated().map { i, v in
        CGPoint(x: CGFloat(i) * step, y: geo.size.height * (1 - CGFloat(v / peak)))
      }
      if points.count > 1 {
        ZStack {
          Path { path in
            path.move(to: CGPoint(x: 0, y: geo.size.height))
            points.forEach { path.addLine(to: $0) }
            path.addLine(to: CGPoint(x: points[points.count - 1].x, y: geo.size.height))
            path.closeSubpath()
          }
          .fill(color.opacity(0.18))
          Path { path in path.addLines(points) }
            .stroke(color, style: StrokeStyle(lineWidth: 1.25, lineCap: .round, lineJoin: .round))
        }
      }
    }
  }
}
