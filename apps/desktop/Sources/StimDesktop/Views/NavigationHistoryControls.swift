import AppKit
import StimKit
import SwiftUI

/// Where the main window is: the page, the "Showing all worktrees" scope of a project page and the device a tile click focused.
struct NavigationDestination: Equatable {
  var selection: SidebarItem?
  var showsAllWorktrees = false
  var focusedDeviceID: String?

  /// The kind of page, which the crash reporter records instead of a project, workspace or worktree name.
  var pageKind: String {
    switch selection {
    case .overview: "overview"
    case .wall: "wall"
    case .project: "project"
    case .environment: "workspace"
    case .archived: "archived-workspace"
    case .worktree: "worktree"
    case .notifications: "notifications"
    case .machine: "machine"
    case nil: "none"
    }
  }
}

/// The main window's back and forward history. `resolves` and `apply` are set by `RootView`.
@MainActor
final class NavigationController: ObservableObject {
  @Published private(set) var history = NavigationHistory(current: NavigationDestination(selection: .overview))
  var resolves: (NavigationDestination) -> Bool = { _ in true }
  var apply: (NavigationDestination) -> Void = { _ in }
  private var monitor: Any?

  var canGoBack: Bool { history.canGoBack(where: resolves) }
  var canGoForward: Bool { history.canGoForward(where: resolves) }

  func record(_ destination: NavigationDestination) {
    history.push(destination)
    report(destination)
  }

  func replaceCurrent(_ destination: NavigationDestination) {
    history.replaceCurrent(destination)
    report(destination)
  }

  private func report(_ destination: NavigationDestination) {
    Diagnostics.shared.breadcrumb("navigation", destination.pageKind)
    Diagnostics.shared.tag("page", destination.pageKind)
  }

  /// The cause of the next `selection` change, set right before the assignment and read by the change handler. One
  /// that nothing read within two seconds (an assignment that changed nothing) is dropped, so it never explains a
  /// later unrelated change.
  private var pendingCause: (cause: NavigationCause, at: Date)?

  func setCause(_ cause: NavigationCause) { pendingCause = (cause, Date()) }

  func takeCause() -> NavigationCause {
    defer { pendingCause = nil }
    guard let pendingCause, Date().timeIntervalSince(pendingCause.at) < 2 else { return .unattributed }
    return pendingCause.cause
  }

  func goBack(via input: NavigationInput) {
    guard let destination = history.goBack(where: resolves) else {
      DebugLog.debug(.navigation, "back via \(input.logDescription) ignored: no earlier page")
      return
    }
    setCause(.back(input))
    apply(destination)
  }

  func goForward(via input: NavigationInput) {
    guard let destination = history.goForward(where: resolves) else {
      DebugLog.debug(.navigation, "forward via \(input.logDescription) ignored: no later page")
      return
    }
    setCause(.forward(input))
    apply(destination)
  }

  func startMonitoring() {
    guard monitor == nil else { return }
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.otherMouseDown, .swipe]) { [weak self] event in
      guard let self, let window = event.window, MainWindow.isMain(window), window.attachedSheet == nil else { return event }
      switch event.type {
      case .otherMouseDown where event.buttonNumber == 3:
        goBack(via: .mouseButton(3))
      case .otherMouseDown where event.buttonNumber == 4:
        goForward(via: .mouseButton(4))
      case .swipe where event.deltaX < 0:
        DebugLog.debug(.navigation, "swipe deltaX=\(event.deltaX) phase=\(event.phase.rawValue) -> back")
        goBack(via: .swipe(deltaX: event.deltaX))
      case .swipe where event.deltaX > 0:
        DebugLog.debug(.navigation, "swipe deltaX=\(event.deltaX) phase=\(event.phase.rawValue) -> forward")
        goForward(via: .swipe(deltaX: event.deltaX))
      case .swipe:
        DebugLog.debug(.navigation, "swipe deltaX=\(event.deltaX) phase=\(event.phase.rawValue) ignored")
        return event
      default:
        return event
      }
      return nil
    }
  }

  func stopMonitoring() {
    if let monitor { NSEvent.removeMonitor(monitor) }
    monitor = nil
  }
}

/// What the Go menu needs from the focused main window.
struct HistoryNavigation {
  var canGoBack: Bool
  var canGoForward: Bool
  var back: () -> Void
  var forward: () -> Void
}

extension FocusedValues {
  @Entry var historyNavigation: HistoryNavigation?
}

struct GoCommands: Commands {
  @FocusedValue(\.historyNavigation) private var navigation

  var body: some Commands {
    CommandMenu("Go") {
      Button("Back") { navigation?.back() }
        .keyboardShortcut("[", modifiers: .command)
        .disabled(navigation?.canGoBack != true)
      Button("Forward") { navigation?.forward() }
        .keyboardShortcut("]", modifiers: .command)
        .disabled(navigation?.canGoForward != true)
    }
  }
}

struct HistoryButtons: View {
  var navigation: NavigationController
  var canGoBack: Bool
  var canGoForward: Bool

  var body: some View {
    HStack(spacing: Space.xxs) {
      Button {
        navigation.goBack(via: .button)
      } label: {
        Label("Back", systemImage: "chevron.left")
      }
      .disabled(!canGoBack)
      .help("Go back")
      Button {
        navigation.goForward(via: .button)
      } label: {
        Label("Forward", systemImage: "chevron.right")
      }
      .disabled(!canGoForward)
      .help("Go forward")
    }
    .buttonStyle(.icon())
    .labelStyle(.iconOnly)
  }
}
