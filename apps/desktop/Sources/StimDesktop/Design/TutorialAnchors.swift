import StimKit
import SwiftUI

enum TutorialAnchorID: Hashable {
  case sidebarRow, buildSection, cacheBadge, deviceTile, viewerControl, logsTab, agentActions, replay, archivedFilter
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

  var anchor: TutorialAnchorID? {
    switch step {
    case "sidebar": return .sidebarRow
    case "build": return .buildSection
    case "rebuild": return .cacheBadge
    case "device": return .deviceTile
    case "logs", "refresh": return .logsTab
    case "agent": return .agentActions
    case "finish", "done": return .archivedFilter
    default: return nil
    }
  }

  var callout: String {
    switch step {
    case "sidebar": return "Select the tutorial workspace"
    case "build": return "Follow the iOS build"
    case "rebuild": return "See the cache outcome in build details"
    case "device": return "Open the live view and choose Control"
    case "logs", "refresh": return "Open Logs"
    case "agent": return "Watch Agent actions and Replay"
    case "finish", "done": return "Find the run in Archived"
    default: return "Follow the tutorial workspace"
    }
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
        if let hint, let id = hint.anchor {
          let match =
            anchors.first {
              $0.key.id == id && ($0.key.workspace == nil || $0.key.workspace == hint.path)
            } ?? anchors.first {
              hint.step == "device" && $0.key.id == .viewerControl
            }
            ?? anchors.first {
              hint.step == "agent" && $0.key.id == .replay
            }
          if let match, hint.path == hint.selectedPath || id == .sidebarRow || id == .archivedFilter,
            geometry[match.value].intersects(CGRect(origin: .zero, size: geometry.size))
          {
            let rect = geometry[match.value]
            RoundedRectangle(cornerRadius: Radius.control)
              .stroke(Palette.accent, lineWidth: 2)
              .frame(width: rect.width + 6, height: rect.height + 6)
              .position(x: rect.midX, y: rect.midY)
              .allowsHitTesting(false)
            Text(hint.callout).font(.stim(.footnote, weight: .semibold))
              .foregroundStyle(Palette.text)
              .padding(.horizontal, Space.md).padding(.vertical, Space.sm)
              .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
              .fixedSize(horizontal: true, vertical: false)
              .position(
                x: max(140, min(geometry.size.width - 140, rect.midX)),
                y: rect.maxY + 38 < geometry.size.height ? rect.maxY + 22 : max(20, rect.minY - 22)
              )
              .allowsHitTesting(false)
          } else if showFallback, hint.path != nil, hint.path != hint.selectedPath {
            Button("Show me", action: hint.showMe)
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
