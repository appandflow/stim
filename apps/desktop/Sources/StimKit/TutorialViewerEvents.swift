import Combine

@MainActor
public final class TutorialViewerEvents: ObservableObject {
  public static let shared = TutorialViewerEvents()
  @Published public private(set) var events: [TutorialViewerEvent] = []

  public init() {}

  public func opened(_ udid: String) { append(.opened(udid)) }
  public func input(_ udid: String) { append(.input(udid)) }

  private func append(_ event: TutorialViewerEvent) { events = Array((events + [event]).suffix(64)) }
  public func reset() { events.removeAll() }
}
