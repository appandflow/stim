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

public enum TutorialMachineState: Equatable, Sendable {
  case none, awaitingApproval, approved

  public init(configured: Bool, approved: Bool) {
    self = approved ? .approved : configured ? .awaitingApproval : .none
  }

  public var buttonTitle: String {
    self == .awaitingApproval ? "Open Add Remote Machine" : "Add Remote Machine"
  }

  public var skipIsPrimary: Bool { self == .none }
  public var showsPrompt: Bool { self == .approved }
}
