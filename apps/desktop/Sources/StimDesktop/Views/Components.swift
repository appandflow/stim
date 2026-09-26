import Lottie
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

/// A worktree's git state: the uncommitted count after a plus-minus sign, arrows for commits ahead and behind, and "merged".
/// Compact for sidebar rows; `chips` for the workspace header. Shows nothing for a clean branch level with its upstream.
struct GitIndicator: View {
  var git: WorktreeGit?
  var chips = false

  var body: some View {
    if let git, git.isNotable {
      if chips {
        if git.uncommitted > 0 {
          Pill(tone: .warning) { Text("\(git.uncommitted) uncommitted") }
            .help("\(git.uncommitted) uncommitted \(git.uncommitted == 1 ? "change" : "changes")")
        }
        if let ahead = git.ahead, ahead > 0 {
          Pill { Text("\u{2191}\(ahead) unpushed").monospacedDigit() }
            .help(git.unpushedLabel(ahead))
            .accessibilityLabel(git.unpushedLabel(ahead))
        }
        if let behind = git.behind, behind > 0 {
          Pill { Text("\u{2193}\(behind) behind").monospacedDigit() }
            .help(git.behindLabel(behind))
            .accessibilityLabel(git.behindLabel(behind))
        }
        if let mergedInto = git.mergedInto { Pill(tone: .accent) { Text("merged") }.help("merged into \(mergedInto)") }
      } else {
        HStack(spacing: Space.xs) {
          if git.uncommitted > 0 {
            Text("\u{00B1}\(git.uncommitted)").foregroundStyle(Palette.secondary)
          }
          if let arrows = git.arrows { Text(arrows).foregroundStyle(Palette.secondary) }
          if git.mergedInto != nil {
            Text("merged")
              .foregroundStyle(Palette.primary)
              .padding(.horizontal, Space.xs)
              .background(RoundedRectangle(cornerRadius: Radius.small).fill(Palette.primary.opacity(Opacity.tint)))
          }
        }
        .font(.stim(.caption2, weight: .semibold))
        .monospacedDigit()
        .fixedSize()
        .help(git.summary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(git.summary)
      }
    }
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
        item.subview.place(
          at: CGPoint(x: x, y: y + (row.height - item.size.height) / 2), proposal: ProposedViewSize(item.size))
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

struct EmptyState: View {
  var title: String
  var message: String
  var showsHero = false
  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(spacing: Space.lg) {
      if showsHero, let jar = BrandAssets.jar(colorScheme) {
        LottieView(animation: .filepath(jar.path))
          .playbackMode(reduceMotion ? .paused(at: .frame(0)) : .playing(.fromProgress(0, toProgress: 1, loopMode: .loop)))
          .resizable()
          .frame(width: 111, height: 180)
          .id(jar)
      }
      Text(title).font(.stim(.headline))
      Text(message).foregroundStyle(Palette.secondary).multilineTextAlignment(.center)
    }
    .padding(Space.huge)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct CommandText: View {
  var command: String

  var body: some View {
    Text(command)
      .font(.stim(.caption, mono: true))
      .foregroundStyle(Palette.secondary)
      .padding(.horizontal, Space.md)
      .padding(.vertical, Space.xs)
      .background(RoundedRectangle(cornerRadius: Radius.chip).fill(Palette.background))
      .textSelection(.enabled)
  }
}

struct Sparkline: View {
  var values: [Double]
  var color: Color = Palette.accent
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
      VStack(alignment: .leading, spacing: Space.xs) {
        HStack(spacing: Space.md) {
          Group {
            if compact {
              Text(build.phase).font(.stim(.caption, mono: true)).foregroundStyle(Palette.primary)
            } else {
              Text("Building \(build.platform)\(build.slot == "default" ? "" : " \u{00B7} \(build.slot)")  ")
                .foregroundStyle(Palette.text)
                + Text(build.phase).font(.stim(.caption, mono: true)).foregroundStyle(Palette.primary)
            }
          }
          .lineLimit(1)
          .truncationMode(.tail)
          BuildOutcomeBadge(build: build)
          Spacer(minLength: 4)
          Text(timing(progress))
            .font(.stim(.caption, mono: true))
            .foregroundStyle(Palette.secondary)
            .lineLimit(1)
            .fixedSize()
        }
        .font(.stim(.footnote))
        if let fraction = progress.fraction {
          ProgressView(value: fraction).tint(Palette.accent)
        } else {
          ProgressView().progressViewStyle(.linear).tint(Palette.accent)
        }
        if let remaining = progress.remaining {
          Text(remaining).font(.stim(.caption2)).foregroundStyle(Palette.tertiary).lineLimit(1)
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

extension View {
  func toolbarBackdrop(_ color: Color) -> some View {
    modifier(ToolbarBackdrop(color: color))
  }
}

private struct ToolbarBackdrop: ViewModifier {
  var color: Color
  @State private var toolbarHeight: CGFloat = 0

  func body(content: Content) -> some View {
    content
      .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.top } action: { toolbarHeight = $0 }
      .overlay(alignment: .top) {
        VStack(spacing: 0) {
          color.frame(height: toolbarHeight)
          LinearGradient(colors: [color, color.opacity(0)], startPoint: .top, endPoint: .bottom)
            .frame(height: 12)
        }
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(false)
      }
  }
}
