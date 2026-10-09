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
          if let spec, let rect, onPage, rect.intersects(CGRect(origin: .zero, size: geometry.size)) {
            RoundedRectangle(cornerRadius: Radius.control)
              .stroke(Palette.accent, lineWidth: 2)
              .frame(width: rect.width + 6, height: rect.height + 6)
              .position(x: rect.midX, y: rect.midY)
              .allowsHitTesting(false)
            Text(spec.callout).font(.stim(.footnote, weight: .semibold))
              .foregroundStyle(Palette.text)
              .padding(.horizontal, Space.md).padding(.vertical, Space.sm)
              .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
              .fixedSize(horizontal: true, vertical: false)
              .position(
                x: max(140, min(geometry.size.width - 140, rect.midX)),
                y: rect.maxY + 38 < geometry.size.height ? rect.maxY + 22 : max(20, rect.minY - 22)
              )
              .allowsHitTesting(false)
          } else if showFallback, hint.offersShowMe, hint.path != nil, hint.path != hint.selectedPath {
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
