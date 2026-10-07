import Combine

@MainActor
public final class TutorialViewerEvents: ObservableObject {
  public static let shared = TutorialViewerEvents()
  @Published public private(set) var events: [TutorialViewerEvent] = []

  public init() {}

  public func opened(_ udid: String) { events.append(.opened(udid)) }
  public func input(_ udid: String) { events.append(.input(udid)) }
  public func reset() { events.removeAll() }
}
