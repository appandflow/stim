/// Thresholds for the compact usage stats (CPU, memory, disk), shared by every surface that shows one so they
/// agree on when a value reads as normal, a caution, or an error.
public enum UsageThresholds {
  public static let cpuWarnFraction = 0.8
  public static let cpuCriticalFraction = 0.95

  /// Below this, the disk stat warns. Also Stim's fixed display floor for "low disk" (distinct
  /// from the configurable `disk.hardFloorGb`).
  public static let lowDiskBytes: Int64 = 20_000_000_000
  /// A quarter of `lowDiskBytes`, so the compact stat also has a critical tier before
  /// `lowDiskBytes` bites.
  public static let diskCriticalBytes: Int64 = lowDiskBytes / 4

  /// The share of the Mac's CPU that `percentOfOneCore` (`ps` %CPU summed over processes, where 100 is one core) uses,
  /// from 0 to 1, so a whole-machine figure never reads above 100%.
  public static func cpuFraction(percentOfOneCore: Double, cores: Int) -> Double {
    min(1, max(0, percentOfOneCore / (100 * Double(max(1, cores)))))
  }

  public static func cpu(fraction: Double) -> Tone {
    fraction >= cpuCriticalFraction ? .error : fraction >= cpuWarnFraction ? .caution : .normal
  }

  /// The more severe of two stat tones, so a stat that combines two readings shows the worse one.
  public static func worse(_ first: Tone, _ second: Tone) -> Tone {
    func rank(_ tone: Tone) -> Int { tone == .error ? 2 : tone == .caution ? 1 : 0 }
    return rank(second) > rank(first) ? second : first
  }

  public static func disk(freeBytes: Int64) -> Tone {
    freeBytes < diskCriticalBytes ? .error : freeBytes < lowDiskBytes ? .caution : .normal
  }

  public static func memory(_ pressure: MachineMemory.Pressure?) -> Tone {
    switch pressure {
    case .critical: return .error
    case .warning: return .caution
    case .normal, nil: return .normal
    }
  }
}
