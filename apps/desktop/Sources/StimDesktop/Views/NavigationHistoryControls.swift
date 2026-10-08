import AppKit
import StimKit
import SwiftUI

/// Where the main window is: the page, the "Showing all worktrees" scope of a project page and the device a tile click focused.
struct NavigationDestination: Equatable {
  var selection: SidebarItem?
  var showsAllWorktrees = false
  var focusedDeviceID: String?
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
  }

  func replaceCurrent(_ destination: NavigationDestination) {
    history.replaceCurrent(destination)
  }

  func goBack() {
    if let destination = history.goBack(where: resolves) { apply(destination) }
  }

  func goForward() {
    if let destination = history.goForward(where: resolves) { apply(destination) }
  }

  /// Mouse buttons 4 and 5 and the two-finger swipe, while the main window is the event's window.
  func startMonitoring() {
    guard monitor == nil else { return }
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.otherMouseDown, .swipe]) { [weak self] event in
      guard let self, let window = event.window, MainWindow.isMain(window), window.attachedSheet == nil else { return event }
      switch event.type {
      case .otherMouseDown where event.buttonNumber == 3:
        goBack()
      case .otherMouseDown where event.buttonNumber == 4:
        goForward()
      case .swipe where event.deltaX < 0:
        goBack()
      case .swipe where event.deltaX > 0:
        goForward()
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

/// The back and forward chevrons at the leading edge of the main window's toolbar.
struct HistoryButtons: View {
  @ObservedObject var navigation: NavigationController

  var body: some View {
    HStack(spacing: Space.xxs) {
      Button(action: navigation.goBack) {
        Label("Back", systemImage: "chevron.left")
      }
      .disabled(!navigation.canGoBack)
      .help("Go back")
      Button(action: navigation.goForward) {
        Label("Forward", systemImage: "chevron.right")
      }
      .disabled(!navigation.canGoForward)
      .help("Go forward")
    }
    .buttonStyle(.icon())
    .labelStyle(.iconOnly)
  }
}
