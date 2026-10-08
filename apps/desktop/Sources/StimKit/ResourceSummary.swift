public enum ResourceKind: Hashable, Sendable {
  case cpu, memory, disk
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
