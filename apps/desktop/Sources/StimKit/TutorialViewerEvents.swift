import Combine

@MainActor
public final class TutorialViewerEvents: ObservableObject {
  public struct Entry: Sendable {
    public let sequence: Int
    public let event: TutorialViewerEvent
  }

  public static let shared = TutorialViewerEvents()
  @Published public private(set) var events: [Entry] = []
  private var sequence = 0

  public init() {}

  public func opened(_ udid: String) { append(.opened(udid)) }
  public func input(_ udid: String) { append(.input(udid)) }

  private func append(_ event: TutorialViewerEvent) {
    sequence += 1
    events = Array((events + [Entry(sequence: sequence, event: event)]).suffix(64))
  }
}
