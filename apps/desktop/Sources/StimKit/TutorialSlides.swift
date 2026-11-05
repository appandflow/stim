/// The tutorial panel shows one slide at a time: a step, or the completion card once the tutorial is finished. The
/// viewed slide is separate from the record's current step, so viewing never changes progress.
public struct TutorialSlides: Equatable, Sendable {
  public static let completion = "complete"

  public let ids: [String]
  /// The slide progress is on: the current step, or the completion card once every step is done.
  public let current: String

  public init(steps: [String], currentStep: String?, finished: Bool) {
    ids = steps + (finished ? [Self.completion] : [])
    current = currentStep ?? Self.completion
  }

  /// The slide to show for `viewed`, which is nil while the panel follows progress.
  public func shown(_ viewed: String?) -> String {
    viewed.flatMap { ids.contains($0) ? $0 : nil } ?? current
  }

  public func previous(_ id: String) -> String? {
    ids.firstIndex(of: id).flatMap { $0 > 0 ? ids[$0 - 1] : nil }
  }

  public func next(_ id: String) -> String? {
    ids.firstIndex(of: id).flatMap { $0 + 1 < ids.count ? ids[$0 + 1] : nil }
  }

  /// A step after the current one, shown dimmed and read-only.
  public func isAhead(_ id: String) -> Bool {
    guard id != Self.completion, let index = ids.firstIndex(of: id), let now = ids.firstIndex(of: current) else {
      return false
    }
    return index > now
  }

  /// What to view after progress moves from `old` to this slide set's current step: the panel follows only when the
  /// user was viewing the step that completed, and otherwise stays where the user looked.
  public func viewed(_ viewed: String?, afterProgressFrom old: String) -> String? {
    viewed == old ? nil : viewed
  }
}
