import StimKit
import SwiftUI

enum TutorialAnchorID: Hashable {
  case sidebarRow, deviceTile, viewerControl, logsTab, archivedFilter
}

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
  var step: String?
  var path: String?
  var selectedPath: String?
  var showMe: () -> Void

  var target: (anchor: TutorialAnchorID, callout: String)? {
    switch step {
    case "sidebar": return (.sidebarRow, "Select the tutorial workspace")
    case "device": return (.deviceTile, "Open the live view, then tap Log an error.")
    case "logs", "refresh": return (.logsTab, "Open Logs")
    case "finish", "done": return (.archivedFilter, "Find the run in Archived")
    default: return nil
    }
  }

  var offersShowMe: Bool {
    ["sidebar", "build", "rebuild", "device", "logs", "refresh", "agent", "finish", "done"].contains(step ?? "")
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
}

private struct TutorialHighlights: ViewModifier {
  @Environment(\.tutorialHint) private var hint
  var showFallback: Bool

  func body(content: Content) -> some View {
    content.overlayPreferenceValue(TutorialAnchorPreference.self) { anchors in
      GeometryReader { geometry in
        if let hint {
          let spec = hint.target
          let match =
            anchors.first {
              $0.key.id == spec?.anchor && ($0.key.workspace == nil || $0.key.workspace == hint.path)
            }
            ?? anchors.first {
              hint.step == "device" && $0.key.id == .viewerControl
            }
          let rect = match.map { geometry[$0.value] }
          let onPage = hint.path == hint.selectedPath || spec?.anchor == .sidebarRow || spec?.anchor == .archivedFilter
          let target = rect.flatMap { onPage && $0.intersects(CGRect(origin: .zero, size: geometry.size)) ? $0 : nil }
          if let spec {
            TutorialGlow(
              rect: target, bounds: geometry.size, callout: spec.callout,
              restartKey: "\(hint.step ?? "")|\(hint.selectedPath ?? "")")
          }
          if target == nil, showFallback, hint.offersShowMe, hint.path != nil, hint.path != hint.selectedPath {
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

private struct TutorialGlow: View {
  static let visibleSeconds = 4.0
  static let fadeSeconds = 0.6
  static let pulsePeriod = 1.4
  static let reshowAfterAbsence = 1.0

  var rect: CGRect?
  var bounds: CGSize
  var callout: String
  var restartKey: String
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var alive = false
  @State private var faded = false
  @State private var present = false
  @State private var absentSince: Date?
  @State private var epoch = 0

  var body: some View {
    Group {
      if alive, let rect {
        TimelineView(reduceMotion ? .animation(minimumInterval: 3600) : .animation) { context in
          let phase = reduceMotion ? 0 : (sin(context.date.timeIntervalSinceReferenceDate * 2 * .pi / Self.pulsePeriod) + 1) / 2
          glow(rect, phase: phase)
        }
        .opacity(faded ? 0 : 1)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
      }
    }
    .onChange(of: rect == nil, initial: true) { _, absent in
      present = !absent
      if absent {
        absentSince = Date()
      } else {
        if let absentSince, Date().timeIntervalSince(absentSince) > Self.reshowAfterAbsence { epoch += 1 }
        absentSince = nil
      }
    }
    .task(id: "\(restartKey)|\(epoch)") {
      alive = false
      faded = false
      while !present {
        try? await Task.sleep(for: .milliseconds(100))
        if Task.isCancelled { return }
      }
      alive = true
      try? await Task.sleep(for: .seconds(Self.visibleSeconds))
      if Task.isCancelled { return }
      withAnimation(.easeOut(duration: Self.fadeSeconds)) { faded = true }
      try? await Task.sleep(for: .seconds(Self.fadeSeconds))
      if !Task.isCancelled { alive = false }
    }
  }

  private func glow(_ rect: CGRect, phase: Double) -> some View {
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
