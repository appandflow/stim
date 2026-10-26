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

  var paths: [String] { [path, secondPath].compactMap { $0 } }

  var onPage: Bool { selectedPath.map(paths.contains) == true }

  var targets: [TutorialGlowTarget] {
    TutorialGlowPath.targets(step: step, ticks: ticks, onPage: onPage, logsShown: logsShown)
  }

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

private struct TutorialLogsHighlightKey: EnvironmentKey {
  static let defaultValue: UUID? = nil
}

extension EnvironmentValues {
  var tutorialLogsHighlight: UUID? {
    get { self[TutorialLogsHighlightKey.self] }
    set { self[TutorialLogsHighlightKey.self] = newValue }
  }

  var tutorialHint: TutorialHint? {
    get { self[TutorialHintKey.self] }
    set { self[TutorialHintKey.self] = newValue }
  }
}

extension View {
  func tutorialDestinationGlow(trigger: UUID?) -> some View {
    overlay {
      if let trigger {
        GeometryReader { geometry in
          TutorialGlow(
            rect: CGRect(origin: .zero, size: geometry.size).insetBy(dx: 5, dy: 5),
            bounds: geometry.size, callout: nil, restartKey: trigger.uuidString)
        }
        .id(trigger)
      }
    }
  }

  func tutorialAnchor(_ id: TutorialAnchorID, workspace: String? = nil) -> some View {
    anchorPreference(key: TutorialAnchorPreference.self, value: .bounds) {
      [TutorialAnchorKey(id: id, workspace: workspace): $0]
    }
  }

  func tutorialHighlights(showFallback: Bool = true, agentGlowDismissed: Bool = false, includesViewerTargets: Bool = false)
    -> some View
  {
    modifier(
      TutorialHighlights(
        showFallback: showFallback, agentGlowDismissed: agentGlowDismissed, includesViewerTargets: includesViewerTargets))
  }

  func tutorialGlowInPlace(_ hint: TutorialHint?, _ anchor: TutorialAnchorID, workspaces: [String] = []) -> some View {
    overlay {
      if let hint, hint.glowsInPlace(anchor, workspaces: workspaces) {
        GeometryReader { geometry in
          TutorialGlow(
            rect: CGRect(origin: .zero, size: geometry.size), bounds: geometry.size, callout: nil,
            restartKey: "\(hint.step ?? "")|\(hint.selectedPath ?? "")|\(anchor)",
            loops: hint.step == "agent")
        }
      }
    }
  }
}

private struct TutorialHighlights: ViewModifier {
  @Environment(\.tutorialHint) private var hint
  @State private var windowKey = false
  var showFallback: Bool
  var agentGlowDismissed: Bool
  var includesViewerTargets: Bool

  func body(content: Content) -> some View {
    content.overlayPreferenceValue(TutorialAnchorPreference.self) { anchors in
      GeometryReader { geometry in
        if windowKey, let hint {
          let bounds = CGRect(origin: .zero, size: geometry.size)
          let targets = hint.targets.filter {
            includesViewerTargets || ![TutorialAnchorID.viewerScreen, .agentActions, .replay].contains($0.anchor)
          }
          let found = targets.lazy.compactMap { target -> (TutorialAnchorID, String, CGRect)? in
            let workspaces = target.anchor == .workspaceNoticeShow ? [hint.path].compactMap { $0 } : hint.paths
            let keys =
              workspaces.map { TutorialAnchorKey(id: target.anchor, workspace: $0) }
              + [TutorialAnchorKey(id: target.anchor, workspace: nil)]
            guard let anchor = keys.lazy.compactMap({ anchors[$0] }).first else { return nil }
            let rect = geometry[anchor]
            guard rect.intersects(bounds) else { return nil }
            return (target.anchor, target.callout, rect)
          }.first
          if let found {
            if found.0 != .agentActions || !agentGlowDismissed {
              TutorialGlow(
                rect: found.2, bounds: geometry.size, callout: found.1,
                restartKey: "\(hint.step ?? "")|\(hint.selectedPath ?? "")|\(found.0)", loops: hint.step == "agent")
            }
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
    .background(WindowStateReader { windowKey = $0 == .key })
  }
}

private struct TutorialGlow: View {
  static let fadeSeconds = 0.6
  static let pulsePeriod = 1.4

  var rect: CGRect
  var bounds: CGSize
  var callout: String?
  var restartKey: String
  var loops = false

  private var highlight: Color {
    Color(red: 1, green: 215.0 / 255.0, blue: 0)
  }
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var faded = false
  @State private var gone = false
  @State private var windowKey = false

  var body: some View {
    ZStack {
      WindowStateReader { windowKey = $0 == .key }
      if windowKey, !gone {
        animatedGlow
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
    .onDisappear { gone = true }
    .task(id: restartKey) {
      gone = false
      faded = false
      guard !loops else { return }
      try? await Task.sleep(for: .seconds(TutorialHint.glowSeconds))
      if Task.isCancelled { return }
      withAnimation(.easeOut(duration: Self.fadeSeconds)) { faded = true }
      try? await Task.sleep(for: .seconds(Self.fadeSeconds))
      if !Task.isCancelled { gone = true }
    }
  }

  private var animatedGlow: some View {
    TimelineView(.periodic(from: .now, by: reduceMotion ? 3600 : 1.0 / 30)) { context in
      let phase =
        reduceMotion ? 1 : (sin(context.date.timeIntervalSinceReferenceDate * 2 * .pi / Self.pulsePeriod) + 1) / 2
      glow(phase: phase)
        .opacity(loops && !reduceMotion ? 0.1 + 0.9 * phase : 1)
    }
    .frame(width: bounds.width, height: bounds.height)
    .opacity(faded ? 0 : 1)
    .animation(.easeOut(duration: Self.fadeSeconds), value: faded)
  }

  private func glow(phase: Double) -> some View {
    let size = CGSize(width: rect.width + 6, height: rect.height + 6)
    let aboveY = rect.minY - 18
    return ZStack {
      RoundedRectangle(cornerRadius: Radius.control + 3)
        .stroke(highlight.opacity(0.45 + 0.25 * phase), lineWidth: 4 + 2 * phase)
        .blur(radius: 6 + 2 * phase)
        .frame(width: size.width, height: size.height)
        .position(x: rect.midX, y: rect.midY)
      RoundedRectangle(cornerRadius: Radius.control + 3)
        .strokeBorder(highlight.opacity(0.4), lineWidth: 1)
        .frame(width: size.width, height: size.height)
        .position(x: rect.midX, y: rect.midY)
      if let callout {
        Text(callout).font(.stim(.footnote, weight: .semibold))
          .foregroundStyle(Color.black)
          .padding(.horizontal, Space.md).padding(.vertical, Space.xs)
          .background(Capsule().fill(highlight))
          .shadow(color: highlight.opacity(0.4), radius: 6)
          .fixedSize(horizontal: true, vertical: false)
          .position(
            x: max(140, min(bounds.width - 140, rect.midX)),
            y: aboveY >= 14 ? aboveY : min(rect.maxY + 18, bounds.height - 14)
          )
      }
    }
  }
}
