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
  @State private var windowKey = false
  var showFallback: Bool

  func body(content: Content) -> some View {
    content.overlayPreferenceValue(TutorialAnchorPreference.self) { anchors in
      GeometryReader { geometry in
        if windowKey, let hint {
          let bounds = CGRect(origin: .zero, size: geometry.size)
          let found = hint.targets.lazy.compactMap { target -> (TutorialAnchorID, String, CGRect)? in
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
    .background(WindowStateReader { windowKey = $0 == .key })
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
  @Environment(\.colorScheme) private var colorScheme
  @State private var faded = false
  @State private var gone = false
  @State private var windowKey = false

  var body: some View {
    ZStack {
      WindowStateReader { windowKey = $0 == .key }
      if windowKey, !gone {
        TutorialGlowSurface(
          content: AnyView(
            TimelineView(reduceMotion ? .animation(minimumInterval: 3600) : .animation) { context in
              let phase =
                reduceMotion ? 0 : (sin(context.date.timeIntervalSinceReferenceDate * 2 * .pi / Self.pulsePeriod) + 1) / 2
              glow(phase: phase)
            }
            .frame(width: bounds.width, height: bounds.height)
            .opacity(faded ? 0 : 1)
            .animation(.easeOut(duration: Self.fadeSeconds), value: faded)
            .padding(TutorialGlowSurface.margin)
            .environment(\.colorScheme, colorScheme)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
          )
        )
        .frame(width: bounds.width, height: bounds.height)
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
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

private struct TutorialGlowSurface: NSViewRepresentable {
  static let margin: CGFloat = 32
  var content: AnyView

  func makeNSView(context: Context) -> TutorialGlowHost { TutorialGlowHost() }

  func updateNSView(_ view: TutorialGlowHost, context: Context) {
    view.content = content
    view.position()
  }

  static func dismantleNSView(_ view: TutorialGlowHost, coordinator: ()) { view.close() }
}

private final class TutorialGlowPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

private final class TutorialGlowHost: NSView {
  var content = AnyView(EmptyView()) {
    didSet { hosting?.rootView = content }
  }
  private weak var owner: NSWindow?
  private var panel: TutorialGlowPanel?
  private var hosting: NSHostingView<AnyView>?
  private var observers: [NSObjectProtocol] = []

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    close()
    guard let window else { return }
    owner = window
    let names: [Notification.Name] = [
      NSWindow.didMoveNotification, NSWindow.didResizeNotification,
      NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
    ]
    observers = names.map { name in
      NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
        self?.position()
      }
    }
    observers.append(
      NotificationCenter.default.addObserver(
        forName: NSWindow.willCloseNotification, object: window, queue: .main
      ) { [weak self] _ in self?.close() })
    position()
  }

  override func layout() {
    super.layout()
    position()
  }

  func position() {
    guard let owner, owner.isKeyWindow, owner.isVisible, !owner.isMiniaturized, owner.occlusionState.contains(.visible),
      bounds.width > 0, bounds.height > 0
    else {
      panel?.orderOut(nil)
      return
    }
    let frame = owner.convertToScreen(convert(bounds, to: nil))
      .insetBy(dx: -TutorialGlowSurface.margin, dy: -TutorialGlowSurface.margin)
    if panel == nil {
      let hosting = NSHostingView(rootView: content)
      hosting.sizingOptions = []
      let panel = TutorialGlowPanel(
        contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      panel.isOpaque = false
      panel.backgroundColor = .clear
      panel.hasShadow = false
      panel.ignoresMouseEvents = true
      panel.hidesOnDeactivate = true
      panel.isReleasedWhenClosed = false
      panel.isExcludedFromWindowsMenu = true
      panel.setAccessibilityElement(false)
      panel.collectionBehavior = [.fullScreenAuxiliary, .ignoresCycle]
      panel.contentView = hosting
      self.hosting = hosting
      self.panel = panel
      owner.addChildWindow(panel, ordered: .above)
    }
    panel?.appearance = owner.effectiveAppearance
    panel?.level = NSWindow.Level(rawValue: owner.level.rawValue + 1)
    panel?.setFrame(frame, display: true)
    if panel?.isVisible == false { panel?.orderFront(nil) }
  }

  func close() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers = []
    if let panel {
      owner?.removeChildWindow(panel)
      panel.orderOut(nil)
      panel.contentView = nil
    }
    panel = nil
    hosting = nil
    owner = nil
  }
}
