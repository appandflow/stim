import AppKit
import Lottie
import StimKit
import SwiftUI

/// A state shown by color and fill. VoiceOver skips it unless `label` names the state, so give one when no text beside
/// the dot says it.
struct StatusDot: View {
  var color: Color
  var filled = true
  var size: CGFloat = 7
  var label: String?

  var body: some View {
    let dot = Circle()
      .fill(filled ? color : .clear)
      .overlay(Circle().strokeBorder(filled ? .clear : color, lineWidth: 1))
      .frame(width: size, height: size)
    if let label {
      dot.accessibilityElement().accessibilityLabel(label)
    } else {
      dot.accessibilityHidden(true)
    }
  }
}

/// The workspace's memory from `stim status`: its processes' footprint, or a fixed estimate as `source` says.
struct MemoryPill: View {
  var mb: Int
  var source: MemorySource?

  var body: some View {
    Pill {
      Image(systemName: "memorychip")
      Text(Format.gigabytes(mb: mb))
    }
    .help(help)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      source != .footprint && source != .rss
        ? "Estimated to use about \(Format.gigabytes(mb: mb)) of memory" : "Uses \(Format.gigabytes(mb: mb)) of memory")
  }

  private var help: String {
    switch source {
    case .footprint: return "Memory the workspace's processes use, as Activity Monitor counts it"
    case .rss: return "Resident memory of the workspace's processes, which overstates simulators"
    case .estimate, .other, nil: return "Committed memory estimate from stim status"
    }
  }
}

/// One pill naming everything driving a workspace's devices, so the device tiles only mark which ones are driven.
struct DriversPill: View {
  var activities: [DeviceActivity?]

  var body: some View {
    TimelineView(.periodic(from: .now, by: 30)) { context in
      if let summary = ActivityBadge.driversSummary(activities, now: context.date) {
        Pill(tone: .brand) {
          StatusDot(color: Palette.primary)
          Text("Driven by \(summary)")
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Driven by \(summary.replacingOccurrences(of: " \u{00B7} ", with: " for "))")
      }
    }
  }
}

/// Lays out subviews left to right, wrapping to a new line when a subview would not fit
/// in the remaining width of the proposed size.
struct FlowLayout: Layout {
  var spacing: CGFloat = 6
  var lineSpacing: CGFloat = 6
  var topAligned = false
  var centered = false

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
      var x = bounds.minX + (centered ? max(0, bounds.width - row.width) / 2 : 0)
      for item in row.items {
        item.subview.place(
          at: CGPoint(x: x, y: topAligned ? y : y + (row.height - item.size.height) / 2),
          proposal: ProposedViewSize(item.size))
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
  var showsPrompts = false
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
      if showsPrompts {
        AgentPromptList().padding(.top, Space.xs)
      }
    }
    .padding(Space.huge)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct AgentPromptList: View {
  @State private var prompts = Array(AgentPrompts.all.shuffled().prefix(3))
  @State private var copied: String?

  var body: some View {
    VStack(spacing: Space.md) {
      Text("Copy a prompt for your coding agent.").foregroundStyle(Palette.secondary)
      ForEach(prompts, id: \.self) { prompt in
        Card {
          HStack(spacing: Space.lg) {
            Text(prompt)
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
            Button {
              NSPasteboard.general.clearContents()
              NSPasteboard.general.setString(prompt, forType: .string)
              copied = prompt
            } label: {
              Label(copied == prompt ? "Copied" : "Copy", systemImage: copied == prompt ? "checkmark" : "doc.on.doc")
            }
            .buttonStyle(.stim(.secondary))
            .help("Copy this prompt to the clipboard")
            .accessibilityLabel(copied == prompt ? "Copied prompt: \(prompt)" : "Copy prompt: \(prompt)")
          }
          .padding(.horizontal, Space.xl)
          .padding(.vertical, Space.lg)
        }
      }
    }
    .frame(maxWidth: 460)
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
            for point in points { path.addLine(to: point) }
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

struct SetupBadge: View {
  var env: Workspace
  var compact = false

  var body: some View {
    if env.isWarming {
      if compact {
        HStack(spacing: Space.xs) {
          ProgressView().controlSize(.mini)
          Text("Warming\u{2026}").font(.stim(.caption2)).foregroundStyle(Palette.accent)
        }
        .fixedSize()
        .help(help)
      } else {
        VStack(alignment: .leading, spacing: Space.xs) {
          Text("Warming\u{2026}").foregroundStyle(Palette.text)
            + Text(env.warmStep.map { "  \($0)" } ?? "").font(.stim(.caption, mono: true)).foregroundStyle(Palette.primary)
          ProgressView().progressViewStyle(.linear).tint(Palette.accent)
        }
        .font(.stim(.footnote))
        .help(help)
      }
    } else if env.phase == "ready" {
      Text("Ready").font(.stim(compact ? .caption2 : .footnote)).foregroundStyle(Palette.accent).fixedSize().help(help)
    }
  }

  private var help: String {
    env.isWarming
      ? "stim worktree warm is running in this workspace\(env.warmStep.map { " (\($0))" } ?? "")."
      : "Warmed and ready: nothing has run in this workspace yet."
  }
}

struct BuildProgressBar: View {
  var build: Build

  var body: some View {
    TimelineView(.buildSeconds(build)) { context in
      let progress = build.progress(at: context.date)
      VStack(alignment: .leading, spacing: Space.xs) {
        HStack(spacing: Space.md) {
          let remote = build.remote(at: context.date)
          (Text(
            "Building \(build.platform)\(build.slot == "default" ? "" : " \u{00B7} \(build.slot)")\(remote.map { " on \($0.host)" } ?? "")  "
          )
          .foregroundStyle(Palette.text)
            + Text(remote.map { $0.phase.lowercased() } ?? build.phase).font(.stim(.caption, mono: true))
            .foregroundStyle(Palette.primary))
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
    let elapsed = Format.elapsed(ms: progress.elapsedMs)
    guard let expected = build.expectedMs, progress.remaining != nil else { return elapsed }
    return "\(elapsed) / ~\(Format.elapsed(ms: expected))"
  }

  private var help: String {
    guard build.expectedMs != nil, let outcome = build.outcome else {
      return "No finished \(build.platform) run of this project to compare against yet"
    }
    return "Median of the last \(build.basis) \(outcome) \(build.platform) runs of this project"
  }
}
