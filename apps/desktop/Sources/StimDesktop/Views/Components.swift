import StimKit
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
      .fixedSize()
  }
}

/// Lays out subviews left to right, wrapping to a new line when a subview would not fit
/// in the remaining width of the proposed size.
struct FlowLayout: Layout {
  var spacing: CGFloat = 6
  var lineSpacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    let rows = rowsFor(subviews: subviews, width: width)
    let height = rows.reduce(0) { $0 + $1.height } + lineSpacing * CGFloat(max(0, rows.count - 1))
    let rowWidth = rows.map(\.width).max() ?? 0
    return CGSize(width: proposal.width ?? rowWidth, height: height)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let rows = rowsFor(subviews: subviews, width: bounds.width)
    var y = bounds.minY
    for row in rows {
      var x = bounds.minX
      for item in row.items {
        item.subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(item.size))
        x += item.size.width + spacing
      }
      y += row.height + lineSpacing
    }
  }

  private struct Item {
    var subview: LayoutSubview
    var size: CGSize
  }

  private struct Row {
    var items: [Item]
    var width: CGFloat
    var height: CGFloat
  }

  private func rowsFor(subviews: Subviews, width: CGFloat) -> [Row] {
    var rows: [Row] = []
    var current: [Item] = []
    var currentWidth: CGFloat = 0
    var currentHeight: CGFloat = 0
    for subview in subviews {
      let size = subview.sizeThatFits(.unspecified)
      if !current.isEmpty, currentWidth + spacing + size.width > width {
        rows.append(Row(items: current, width: currentWidth, height: currentHeight))
        current = []
        currentWidth = 0
        currentHeight = 0
      }
      if !current.isEmpty { currentWidth += spacing }
      current.append(Item(subview: subview, size: size))
      currentWidth += size.width
      currentHeight = max(currentHeight, size.height)
    }
    if !current.isEmpty {
      rows.append(Row(items: current, width: currentWidth, height: currentHeight))
    }
    return rows
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
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    VStack(spacing: 14) {
      if showsHero, let hero = BrandAssets.hero(colorScheme) {
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

struct BuildProgressBar: View {
  var build: Build
  var compact = false

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let progress = build.progress(at: context.date)
      VStack(alignment: .leading, spacing: 5) {
        HStack(spacing: 8) {
          Group {
            if compact {
              Text(build.phase).font(Theme.mono()).foregroundStyle(Theme.primary)
            } else {
              Text("Building \(build.platform)\(build.slot == "default" ? "" : " \u{00B7} \(build.slot)")  ")
                .foregroundStyle(Theme.text)
                + Text(build.phase).font(Theme.mono()).foregroundStyle(Theme.primary)
            }
          }
          .lineLimit(1)
          .truncationMode(.tail)
          BuildOutcomeBadge(build: build)
          Spacer(minLength: 4)
          Text(timing(progress))
            .font(Theme.mono())
            .foregroundStyle(Theme.secondary)
            .lineLimit(1)
            .fixedSize()
        }
        .font(Theme.body(11.5))
        if let fraction = progress.fraction {
          ProgressView(value: fraction).tint(Theme.lavender)
        } else {
          ProgressView().progressViewStyle(.linear).tint(Theme.lavender)
        }
        if let remaining = progress.remaining {
          Text(remaining).font(Theme.body(10.5)).foregroundStyle(Theme.tertiary).lineLimit(1)
        }
      }
      .help(help)
    }
  }

  private func timing(_ progress: BuildProgress) -> String {
    let elapsed = formatDuration(ms: progress.elapsedMs)
    guard let expected = build.expectedMs, progress.remaining != nil else { return elapsed }
    return "\(elapsed) / ~\(formatDuration(ms: expected))"
  }

  private var help: String {
    guard build.expectedMs != nil, let outcome = build.outcome else {
      return "No finished \(build.platform) run of this project to compare against yet"
    }
    return "Median of the last \(build.basis) \(outcome) \(build.platform) runs of this project"
  }
}
