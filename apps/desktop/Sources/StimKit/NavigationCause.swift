import Foundation

/// The input that asked the main window to go back or forward.
public enum NavigationInput: Equatable, Sendable {
  case button
  case menu
  case mouseButton(Int)
  case swipe(deltaX: Double)

  public var logDescription: String {
    switch self {
    case .button: "toolbar button"
    case .menu: "Go menu or Cmd-[ / Cmd-]"
    case .mouseButton(let number): "mouse button \(number)"
    case .swipe(let deltaX): "swipe deltaX=\(deltaX)"
    }
  }
}

/// Why the main window changed page.
public enum NavigationCause: Equatable, Sendable {
  case click(String)
  case command(String)
  case back(NavigationInput)
  case forward(NavigationInput)
  case request(String)
  case automatic(String)
  case unattributed

  public var logDescription: String {
    switch self {
    case .click(let control): "click \(control)"
    case .command(let name): "menu \(name)"
    case .back(let input): "back via \(input.logDescription)"
    case .forward(let input): "forward via \(input.logDescription)"
    case .request(let name): "open request \(name)"
    case .automatic(let reason): "automatic \(reason)"
    case .unattributed: "unattributed"
    }
  }

  /// Whether the person pointed at this page. A swipe can come from a gesture meant for a scroll view, so it does not count.
  public var isDeliberate: Bool {
    switch self {
    case .click, .command: true
    case .back(let input), .forward(let input):
      if case .swipe = input { false } else { true }
    case .request, .automatic, .unattributed: false
    }
  }
}
