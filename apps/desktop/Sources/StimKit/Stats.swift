/// The payload printed by `stim stats --json` inside a workspace.
public struct ProjectStats: Decodable, Sendable {
  public struct Platform: Decodable, Sendable {
    public var runs: Int
    public var failed: Int
    public var hits: Int
    public var misses: Int
    public var timeSavedMs: Double?
    public var lastColdBuildMs: Double?

    public var hitRate: Double {
      let lookups = hits + misses
      return lookups == 0 ? 0 : Double(hits) / Double(lookups)
    }
  }

  public struct Scope: Decodable, Sendable {
    public var ios: Platform?
    public var android: Platform?
  }

  public var project: Scope?
}

/// Where this Mac's compiling builds ran and why: the `offload` part of `stim stats --json`, nil from a stim that
/// predates it.
public struct BuildPlacements: Decodable, Sendable {
  public struct Today: Decodable, Sendable {
    public var here: Int
    public var offloaded: Int
    public var fellBack: Int
  }

  public struct Counts: Decodable, Sendable {
    public var offloaded: Int
    public var offloadedMs: Double
    /// Local estimate minus offloaded build time, summed; negative when the machine was slower.
    public var savedMs: Double
    public var fallbacks: Int
  }

  public struct Machine: Decodable, Sendable {
    public var today: Counts
    public var total: Counts
  }

  public struct Placement: Decodable, Hashable, Sendable {
    public enum Decision: String, Decodable, Sendable {
      case here, offloaded, unknown
      case fellBack = "fell-back"

      public init(from decoder: Decoder) throws {
        self = Decision(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
      }
    }

    public var at: String
    public var project: String
    public var platform: String
    public var decision: Decision
    public var reason: String
    public var machine: String?
    public var buildMs: Double?
    public var localEstimateMs: Double?
    public var failed: Bool?
    public var slotWaitMs: Double?

    /// The reason without the `<machine>: ` prefix a fallback carries, since `title` already names the machine.
    public var shortReason: String {
      guard let machine, reason.hasPrefix("\(machine): ") else { return reason }
      return String(reason.dropFirst(machine.count + 2))
    }

    /// "Built here", "Built on mini", "Built here after mini".
    public var title: String {
      let name = machine.map(machineName)
      switch decision {
      case .here: return "Built here"
      case .offloaded: return "Built on \(name ?? "a build machine")"
      case .fellBack: return name.map { "Built here after \($0)" } ?? "Built here after offloading"
      case .unknown: return "Built"
      }
    }
  }

  public var today: Today
  public var machines: [String: Machine]
  /// Newest first.
  public var placements: [Placement]

  /// The placements that went to `machine` or fell back from it, newest first.
  public func placements(for machine: String) -> [Placement] {
    placements.filter { $0.machine == machine && $0.decision != .here }
  }

  /// The placements that built here without trying a build machine, newest first.
  public var here: [Placement] { placements.filter { $0.decision == .here } }
}

public struct MachineStats: Decodable, Sendable {
  public var offload: BuildPlacements?
}
