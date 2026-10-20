public enum ResourceKind: Hashable, Sendable {
  case cpu, memory, disk

  /// The SF Symbol the toolbar's resource summary and a remote Mac's row show for this resource.
  public var icon: String {
    switch self {
    case .cpu: return "speedometer"
    case .memory: return "memorychip"
    case .disk: return "internaldrive"
    }
  }
}

public enum ResourceSummaryEntry: Equatable, Sendable {
  case item(ResourceKind)
  case divider
}

public enum ResourceSummary {
  public static func entries(cpu: Bool, memory: Bool, disk: Bool) -> [ResourceSummaryEntry] {
    let kinds: [ResourceKind] = [cpu ? .cpu : nil, memory ? .memory : nil, disk ? .disk : nil].compactMap { $0 }
    return kinds.enumerated().flatMap { index, kind -> [ResourceSummaryEntry] in
      index == 0 ? [.item(kind)] : [.divider, .item(kind)]
    }
  }
}
