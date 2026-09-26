import Foundation

/// When Stim Desktop's autopilot runs its cleanup commands.
public enum AutopilotSchedule {
  /// True once the most recent `hour`:00 at or before `now` is later than `lastRun`, so a nightly run
  /// the Mac slept through happens at the next check.
  public static func nightlyDue(now: Date, hour: Int, lastRun: Date, calendar: Calendar = .current) -> Bool {
    guard let today = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: now) else { return false }
    let scheduled = today <= now ? today : calendar.date(byAdding: .day, value: -1, to: today) ?? today
    return lastRun < scheduled
  }

  /// A booted device and when the app last saw its screen change.
  public struct Device: Sendable {
    public var activity: DeviceActivity?
    public var screenChangedAt: Date?

    public init(activity: DeviceActivity?, screenChangedAt: Date?) {
      self.activity = activity
      self.screenChangedAt = screenChangedAt
    }
  }

  /// Whether `stim gc --idle <minutes>m` has a device to shut down. The CLI cannot see screen changes, so
  /// when a device it counts as idle that long has a screen the app saw change since, the run waits:
  /// `gc --idle` would shut that device down too.
  public static func idleShutdownDue(_ devices: [Device], minutes: Int, now: Date) -> Bool {
    let threshold = TimeInterval(minutes * 60)
    func idleFor(_ badge: ActivityBadge?) -> TimeInterval? {
      if case .idle(let seconds) = badge { return seconds }
      return nil
    }
    var due = false
    for device in devices {
      guard let cli = idleFor(ActivityBadge(device.activity, now: now)), cli >= threshold else { continue }
      let seen = idleFor(ActivityBadge(device.activity, screenChangedAt: device.screenChangedAt, now: now))
      guard let seen, seen >= threshold else { return false }
      due = true
    }
    return due
  }

  public static func idleDuration(minutes: Int) -> String { "\(minutes)m" }

  /// The nightly cleanup reclaims only what has gone unused for `olderThanDays`: merged worktrees and clean ones
  /// idle that long, build outputs and cache entries unused that long, and devices parked or unused that long.
  /// Pressure runs stay unbounded with `PressurePlan.arguments`.
  public static func nightlyArguments(olderThanDays: Int) -> [String] {
    ["gc", "--delete", "--worktrees", "--older-than", String(olderThanDays), "--json"]
  }
}

/// Free disk under the `budget.minFreeDiskGb` Stim enforces, and what `stim gc --delete` would do about it.
public struct PressurePlan: Hashable, Sendable {
  public var freeBytes: Int64
  /// The larger of `budget.minFreeDiskGb` and `budget.hardFloorDiskGb`, in the CLI's binary gigabytes.
  public var minimumFreeGb: Double
  /// Below `budget.hardFloorDiskGb`, where `start`, `ios` and `android` refuse with STIM_LOW_DISK.
  public var belowHardFloor: Bool
  public var clearsWorkspaces: Int
  public var removesWorktrees: Int
  public var deletesDevices: Int
  public var reclaimableBytes: Int64

  public var isEmpty: Bool { clearsWorkspaces + removesWorktrees + deletesDevices == 0 && reclaimableBytes == 0 }

  public static let arguments = ["gc", "--delete", "--json"]

  /// The plan when free space is under the budget, else nil. A budget of 0 turns the check off, as in the CLI.
  public static func make(freeBytes: Int64, minimumFreeGb: Double, hardFloorGb: Double, report: GcReport?)
    -> PressurePlan?
  {
    let minimum = max(minimumFreeGb, hardFloorGb)
    guard minimum > 0, Double(freeBytes) < minimum * gib else { return nil }
    return PressurePlan(
      freeBytes: freeBytes, minimumFreeGb: minimum, belowHardFloor: Double(freeBytes) < hardFloorGb * gib,
      clearsWorkspaces: report?.clearableOutputs.count ?? 0, removesWorktrees: report?.mergedWorktrees.count ?? 0,
      deletesDevices: report?.deletableDevices.count ?? 0, reclaimableBytes: report?.reclaimable.bytes ?? 0)
  }

  static let gib = 1_073_741_824.0

  public var headline: String {
    let free = (Double(freeBytes) / Self.gib * 10).rounded() / 10
    let budget = minimumFreeGb.rounded() == minimumFreeGb ? String(Int(minimumFreeGb)) : String(minimumFreeGb)
    return "Disk \(free) GB free, under the \(budget) GB Stim budget"
  }

  /// What `stim gc --delete` would do, as one sentence.
  public var proposal: String {
    guard !isEmpty else {
      return "Stim has nothing it can reclaim safely. Open Storage to see what uses the space."
    }
    var parts: [String] = []
    if clearsWorkspaces > 0 {
      parts.append("clear the build outputs of \(Self.count(clearsWorkspaces, "idle workspace"))")
    }
    if removesWorktrees > 0 { parts.append("remove \(Self.count(removesWorktrees, "merged worktree"))") }
    if deletesDevices > 0 { parts.append("delete \(Self.count(deletesDevices, "unused owned device"))") }
    if parts.isEmpty { parts.append("empty what stim gc reports") }
    let list = parts.count == 1 ? parts[0] : parts.dropLast().joined(separator: ", ") + " and " + parts.last!
    let freed = reclaimableBytes > 0 ? " to free about \(Self.format(reclaimableBytes))" : ""
    return list.prefix(1).uppercased() + list.dropFirst() + freed + "."
  }

  static func count(_ n: Int, _ noun: String) -> String { n == 1 ? "1 \(noun)" : "\(n) \(noun)s" }

  static func format(_ bytes: Int64) -> String { ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file) }
}

/// One autopilot or plan run, kept in the app's activity log.
public struct AutopilotLogEntry: Codable, Hashable, Identifiable, Sendable {
  public enum Trigger: String, Codable, Sendable {
    case idle, nightly, pressure, manual, pullRequests

    public var title: String {
      switch self {
      case .idle: return "Idle devices"
      case .nightly: return "Nightly cleanup"
      case .pressure: return "Disk pressure"
      case .manual: return "Requested"
      case .pullRequests: return "Finished pull requests"
      }
    }
  }

  public var id: UUID
  public var date: Date
  public var trigger: Trigger
  public var command: String
  public var exitStatus: Int32?
  public var note: String?

  public init(date: Date, trigger: Trigger, command: String, exitStatus: Int32?, note: String?) {
    id = UUID()
    self.date = date
    self.trigger = trigger
    self.command = command
    self.exitStatus = exitStatus
    self.note = note
  }
}

public enum AutopilotLog {
  public static let limit = 200

  /// `entries` with `entry` first, keeping the newest `limit`.
  public static func appending(_ entry: AutopilotLogEntry, to entries: [AutopilotLogEntry]) -> [AutopilotLogEntry] {
    Array(([entry] + entries).prefix(limit))
  }

  public static func decode(_ data: Data?) -> [AutopilotLogEntry] {
    data.flatMap { try? JSONDecoder().decode([AutopilotLogEntry].self, from: $0) } ?? []
  }

  public static func encode(_ entries: [AutopilotLogEntry]) -> Data? { try? JSONEncoder().encode(entries) }
}
