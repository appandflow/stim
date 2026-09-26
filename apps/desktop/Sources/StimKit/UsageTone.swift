/// Severity for a compact usage stat (CPU, memory, disk), shared by every surface that shows
/// one so they agree on when a value reads as normal, a warning, or critical.
public enum UsageTone: Sendable, Equatable {
  case normal
  case warn
  case critical
}

/// Thresholds for `UsageTone`. These mirror `apps/mobile/src/lib/home.ts`'s `machineStats`
/// constants, so the phone and desktop color the same stat the same way at the same value.
public enum UsageThresholds {
  public static let cpuWarnFraction = 0.8
  public static let cpuCriticalFraction = 0.95

  /// Below this, the disk stat warns. Also Stim's fixed display floor for "low disk" (distinct
  /// from a project's configurable `budget.hardFloorDiskGb`).
  public static let lowDiskBytes: Int64 = 20_000_000_000
  /// A quarter of `lowDiskBytes`, so the compact stat also has a critical tier before
  /// `lowDiskBytes` bites.
  public static let diskCriticalBytes: Int64 = lowDiskBytes / 4

  public static func cpu(fraction: Double) -> UsageTone {
    fraction >= cpuCriticalFraction ? .critical : fraction >= cpuWarnFraction ? .warn : .normal
  }

  public static func disk(freeBytes: Int64) -> UsageTone {
    freeBytes < diskCriticalBytes ? .critical : freeBytes < lowDiskBytes ? .warn : .normal
  }

  public static func memory(_ pressure: MachineMemory.Pressure?) -> UsageTone {
    switch pressure {
    case .critical: return .critical
    case .warning: return .warn
    case .normal, nil: return .normal
    }
  }
}
