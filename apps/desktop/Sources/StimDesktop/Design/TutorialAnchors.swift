import StimKit
import SwiftUI

struct TutorialAnchorKey: Hashable {
  var id: TutorialAnchorID
  var workspace: String?
}

struct TutorialAnchorPreference: PreferenceKey {
  static var defaultValue: [TutorialAnchorKey: Anchor<CGRect>] = [:]
  static func reduce(value: inout [TutorialAnchorKey: Anchor<CGRect>], nextValue: () -> [TutorialAnchorKey: Anchor<CGRect>]) {
    value.merge(nextValue(), uniquingKeysWith: { _, next in next })
  }
}

struct TutorialHint {
  static let glowSeconds = 4.0

  var step: String?
  /// The first change's worktree.
  var path: String?
  var secondPath: String?
  var selectedPath: String?
  var logsShown = false
  var ticks: [TutorialTick] = []
  var showMe: () -> Void

  /// The worktrees whose controls this step may point at, the first change's first.
  var paths: [String] { [path, secondPath].compactMap { $0 } }

  var onPage: Bool { selectedPath.map(paths.contains) == true }

  var targets: [TutorialGlowTarget] {
    TutorialGlowPath.targets(step: step, ticks: ticks, onPage: onPage, logsShown: logsShown)
  }

  /// Whether a control that no content overlay reaches, such as a toolbar item or a sidebar row, glows itself. A
  /// sidebar row is a hop only off the tutorial pages, and only a row holding a tutorial worktree glows.
  func glowsInPlace(_ anchor: TutorialAnchorID, workspaces: [String] = []) -> Bool {
    anchor == .sidebarRow
      ? targets.contains { $0.anchor == anchor } && workspaces.contains(where: paths.contains)
      : targets.first?.anchor == anchor
  }

  var offersShowMe: Bool {
    ["device", "agent", "logs", "finish", "done"].contains(step ?? "")
  }
}

private struct TutorialHintKey: EnvironmentKey {
  static let defaultValue: TutorialHint? = nil
}

extension EnvironmentValues {
  var tutorialHint: TutorialHint? {
    get { self[TutorialHintKey.self] }
    set { self[TutorialHintKey.self] = newValue }
  }
}

extension View {
  func tutorialAnchor(_ id: TutorialAnchorID, workspace: String? = nil) -> some View {
    anchorPreference(key: TutorialAnchorPreference.self, value: .bounds) {
      [TutorialAnchorKey(id: id, workspace: workspace): $0]
    }
  }

  func tutorialHighlights(showFallback: Bool = true) -> some View {
    modifier(TutorialHighlights(showFallback: showFallback))
  }

  /// A glow drawn on the view itself, for a control that no content overlay reaches, such as a toolbar item.
  func tutorialGlowInPlace(_ hint: TutorialHint?, _ anchor: TutorialAnchorID, workspaces: [String] = []) -> some View {
    overlay {
      if let hint, hint.glowsInPlace(anchor, workspaces: workspaces) {
        GeometryReader { geometry in
          TutorialGlow(
            rect: CGRect(origin: .zero, size: geometry.size), bounds: geometry.size, callout: nil,
            restartKey: "\(hint.step ?? "")|\(hint.selectedPath ?? "")|\(anchor)")
        }
      }
    }
  }
}

private struct TutorialHighlights: ViewModifier {
  @Environment(\.tutorialHint) private var hint
  var showFallback: Bool

  func body(content: Content) -> some View {
    content.overlayPreferenceValue(TutorialAnchorPreference.self) { anchors in
      GeometryReader { geometry in
        if let hint {
          let bounds = CGRect(origin: .zero, size: geometry.size)
          let found = hint.targets.lazy.compactMap { target -> (TutorialAnchorID, String, CGRect)? in
            let keys =
              hint.paths.map { TutorialAnchorKey(id: target.anchor, workspace: $0) }
              + [TutorialAnchorKey(id: target.anchor, workspace: nil)]
            guard let anchor = keys.lazy.compactMap({ anchors[$0] }).first else { return nil }
            let rect = geometry[anchor]
            guard rect.intersects(bounds) else { return nil }
            return (target.anchor, target.callout, rect)
          }.first
          if let found {
            TutorialGlow(
              rect: found.2, bounds: geometry.size, callout: found.1,
              restartKey: "\(hint.step ?? "")|\(hint.selectedPath ?? "")|\(found.0)")
          } else if showFallback, hint.offersShowMe, hint.path != nil, !hint.onPage {
            Button("Show Me", action: hint.showMe)
              .buttonStyle(.stim(.secondary))
              .accessibilityLabel("Show the tutorial workspace")
              .padding(Space.md)
              .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          }
        }
      }
    }
  }
}

/// A pulsing glow with a capsule label that fades after a few seconds, and shows again when the target changes or
/// comes back after an absence.
private struct TutorialGlow: View {
  static let fadeSeconds = 0.6
  static let pulsePeriod = 1.4

  var rect: CGRect
  var bounds: CGSize
  var callout: String?
  var restartKey: String
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var faded = false
  @State private var gone = false

  var body: some View {
    Group {
      if !gone {
        TimelineView(reduceMotion ? .animation(minimumInterval: 3600) : .animation) { context in
          let phase =
            reduceMotion ? 0 : (sin(context.date.timeIntervalSinceReferenceDate * 2 * .pi / Self.pulsePeriod) + 1) / 2
          glow(phase: phase)
        }
        .opacity(faded ? 0 : 1)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
      }
    }
    .task(id: restartKey) {
      gone = false
      faded = false
      try? await Task.sleep(for: .seconds(TutorialHint.glowSeconds))
      if Task.isCancelled { return }
      withAnimation(.easeOut(duration: Self.fadeSeconds)) { faded = true }
      try? await Task.sleep(for: .seconds(Self.fadeSeconds))
      if !Task.isCancelled { gone = true }
    }
  }

  private func glow(phase: Double) -> some View {
    let size = CGSize(width: rect.width + 6, height: rect.height + 6)
    let aboveY = rect.minY - 18
    return ZStack {
      RoundedRectangle(cornerRadius: Radius.control + 3)
        .stroke(Palette.accent.opacity(0.45 + 0.25 * phase), lineWidth: 4 + 2 * phase)
        .blur(radius: 6 + 2 * phase)
        .frame(width: size.width, height: size.height)
        .position(x: rect.midX, y: rect.midY)
      RoundedRectangle(cornerRadius: Radius.control + 3)
        .strokeBorder(Palette.accent.opacity(0.4), lineWidth: 1)
        .frame(width: size.width, height: size.height)
        .position(x: rect.midX, y: rect.midY)
      if let callout {
        Text(callout).font(.stim(.footnote, weight: .semibold))
          .foregroundStyle(Palette.onPrimary)
          .padding(.horizontal, Space.md).padding(.vertical, Space.xs)
          .background(Capsule().fill(Palette.accent))
          .shadow(color: Palette.accent.opacity(0.4), radius: 6)
          .fixedSize(horizontal: true, vertical: false)
          .position(
            x: max(140, min(bounds.width - 140, rect.midX)),
            y: aboveY >= 14 ? aboveY : min(rect.maxY + 18, bounds.height - 14)
          )
      }
    }
  }
}
