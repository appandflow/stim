public enum TutorialPhoneState: Equatable, Sendable {
  case serverOff, unpaired, paired

  public init(pairedPhoneCount: Int?) {
    if let pairedPhoneCount {
      self = pairedPhoneCount > 0 ? .paired : .unpaired
    } else {
      self = .serverOff
    }
  }

  public var buttonTitle: String {
    switch self {
    case .serverOff, .unpaired: return "Pair a Phone"
    case .paired: return "Done Already"
    }
  }
}
