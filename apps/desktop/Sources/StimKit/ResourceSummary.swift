public enum ResourceKind: Hashable, Sendable {
  case cpu, load, memory, disk

  /// The SF Symbol the toolbar's resource summary and a remote Mac's row show for this resource.
  public var icon: String {
    switch self {
    case .cpu: return "speedometer"
    case .load: return "gauge.with.dots.needle.67percent"
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
  public static func entries(cpu: Bool, load: Bool = false, memory: Bool, disk: Bool) -> [ResourceSummaryEntry] {
    let kinds: [ResourceKind] = [cpu ? .cpu : nil, load ? .load : nil, memory ? .memory : nil, disk ? .disk : nil].compactMap {
      $0
    }
    return kinds.enumerated().flatMap { index, kind -> [ResourceSummaryEntry] in
      index == 0 ? [.item(kind)] : [.divider, .item(kind)]
    }
  }
}
