/// The back and forward stack of the main window. `isValid` tells whether a destination still resolves, so a
/// removed or archived workspace is skipped instead of landing on a blank page.
public struct NavigationHistory<Destination: Equatable> {
  public static var defaultLimit: Int { 50 }

  public private(set) var entries: [Destination]
  public private(set) var index: Int
  public let limit: Int

  public init(current: Destination, limit: Int = NavigationHistory.defaultLimit) {
    entries = [current]
    index = 0
    self.limit = max(1, limit)
  }

  public var current: Destination { entries[index] }

  /// Navigating away from an earlier entry drops the forward entries. Pushing the current destination does nothing.
  public mutating func push(_ destination: Destination) {
    guard destination != current else { return }
    entries.removeSubrange((index + 1)...)
    entries.append(destination)
    if entries.count > limit { entries.removeFirst(entries.count - limit) }
    index = entries.count - 1
  }

  public mutating func replaceCurrent(_ destination: Destination) {
    entries[index] = destination
  }

  public func canGoBack(where isValid: (Destination) -> Bool = { _ in true }) -> Bool {
    previousIndex(where: isValid) != nil
  }

  public func canGoForward(where isValid: (Destination) -> Bool = { _ in true }) -> Bool {
    nextIndex(where: isValid) != nil
  }

  /// Moves to the nearest earlier destination that resolves and differs from the current one.
  public mutating func goBack(where isValid: (Destination) -> Bool = { _ in true }) -> Destination? {
    guard let target = previousIndex(where: isValid) else { return nil }
    index = target
    return current
  }

  public mutating func goForward(where isValid: (Destination) -> Bool = { _ in true }) -> Destination? {
    guard let target = nextIndex(where: isValid) else { return nil }
    index = target
    return current
  }

  private func previousIndex(where isValid: (Destination) -> Bool) -> Int? {
    entries[..<index].indices.reversed().first { isValid(entries[$0]) && entries[$0] != current }
  }

  private func nextIndex(where isValid: (Destination) -> Bool) -> Int? {
    entries[(index + 1)...].indices.first { isValid(entries[$0]) && entries[$0] != current }
  }
}
