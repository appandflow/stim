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

/// A worktree's git state: a dot with the uncommitted count, arrows for commits ahead and behind, and "merged".
/// Compact for sidebar rows; `chips` for the workspace header. Shows nothing for a clean branch level with its upstream.
struct GitIndicator: View {
  var git: WorktreeGit?
  var chips = false

  var body: some View {
    if let git, git.isNotable {
      if chips {
        if git.uncommitted > 0 { Chip(tint: Theme.warn) { Text("\(git.uncommitted) uncommitted") } }
        if let arrows = git.arrows { Chip { Text(arrows).monospacedDigit() } }
        if git.mergedInto != nil { Chip(tint: Theme.primary) { Text("merged") } }
      } else {
        HStack(spacing: 4) {
          if git.uncommitted > 0 {
            StatusDot(color: Theme.warn)
            Text("\(git.uncommitted)").foregroundStyle(Theme.warn)
          }
          if let arrows = git.arrows { Text(arrows).foregroundStyle(Theme.secondary) }
          if git.mergedInto != nil {
            Text("merged")
              .foregroundStyle(Theme.primary)
              .padding(.horizontal, 4)
              .background(RoundedRectangle(cornerRadius: 4).fill(Theme.primary.opacity(0.14)))
          }
        }
        .font(Theme.body(10.5, weight: .semibold))
        .monospacedDigit()
        .fixedSize()
        .help(git.summary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(git.summary)
      }
    }
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
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(spacing: 14) {
      if showsHero, let jar = BrandAssets.jar(colorScheme) {
        LottieView(animation: .filepath(jar.path))
          .playbackMode(reduceMotion ? .paused(at: .frame(0)) : .playing(.fromProgress(0, toProgress: 1, loopMode: .loop)))
          .resizable()
          .frame(width: 111, height: 180)
          .id(jar)
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

enum StimButtonVariant {
  case primary
  case secondary
  case destructive
}

enum StimButtonSizing {
  case small
  case regular

  fileprivate var height: CGFloat { self == .small ? 24 : 28 }
  fileprivate var horizontalPadding: CGFloat { self == .small ? 10 : 13 }
  fileprivate var font: Font { self == .small ? Theme.body(11.5, weight: .semibold) : Theme.body(12.5, weight: .semibold) }
}

/// The small rounded pill used for card and inline actions across Desktop: an accent-tinted fill
/// for `secondary`, a solid accent fill for `primary`, and a red tint for `destructive`.
struct StimButtonStyle: ButtonStyle {
  var variant: StimButtonVariant = .secondary
  var sizing: StimButtonSizing = .small

  func makeBody(configuration: Configuration) -> some View {
    StimButtonBody(configuration: configuration, variant: variant, sizing: sizing)
  }
}

extension ButtonStyle where Self == StimButtonStyle {
  static func stim(_ variant: StimButtonVariant = .secondary, _ sizing: StimButtonSizing = .small) -> StimButtonStyle {
    StimButtonStyle(variant: variant, sizing: sizing)
  }
}

private struct StimButtonBody: View {
  var configuration: ButtonStyleConfiguration
  var variant: StimButtonVariant
  var sizing: StimButtonSizing
  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.isFocused) private var isFocused
  @State private var hovering = false

  var body: some View {
    configuration.label
      .font(sizing.font)
      .foregroundStyle(foreground)
      .padding(.horizontal, sizing.horizontalPadding)
      .frame(height: sizing.height)
      .background(Capsule().fill(fill))
      .overlay(Capsule().strokeBorder(Theme.lavender.opacity(isFocused ? 0.8 : 0), lineWidth: 2))
      .contentShape(Capsule())
      .opacity(isEnabled ? 1 : 0.45)
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
      .animation(.easeOut(duration: 0.1), value: hovering)
      .onHover { hovering = $0 }
  }

  private var accent: Color {
    switch variant {
    case .primary: return Theme.purple
    case .secondary: return Theme.lavender
    case .destructive: return Theme.error
    }
  }

  private var foreground: Color { variant == .primary ? .white : accent }

  private var fill: Color {
    switch variant {
    case .primary:
      return accent.opacity(configuration.isPressed ? 0.8 : hovering ? 1 : 0.92)
    case .secondary, .destructive:
      return accent.opacity(configuration.isPressed ? 0.22 : hovering ? 0.17 : 0.11)
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
