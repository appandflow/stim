import Foundation

/// The `daemon` block of `stim status --json` and of stim-server's machine view: the home's stim-daemon, the
/// pressure level its last tick measured, and the actions it took last.
public struct DaemonStatus: Decodable, Equatable, Sendable {
  public struct Running: Decodable, Equatable, Sendable {
    public var pid: Int
    public var since: String
  }

  public struct Pressure: Decodable, Equatable, Sendable {
    /// `normal`, `high` or `critical`.
    public var level: String
    public var disk: String?
    public var memory: String?
    public var reasons: [String]

    public init(level: String, disk: String? = nil, memory: String? = nil, reasons: [String] = []) {
      self.level = level
      self.disk = disk
      self.memory = memory
      self.reasons = reasons
    }
  }

  /// One action of the pressure ladder, the idle or dormant stage, or the reclaim for a waiting boot.
  public struct Action: Decodable, Equatable, Sendable, Identifiable {
    public var rung: Int
    public var kind: String
    public var target: String
    public var workspace: String?
    /// `done`, `failed` or `would` (report mode).
    public var outcome: String
    public var bytes: Int64
    public var detail: String
    public var restore: String?
    public var at: String

    public var id: String { "\(at) \(kind) \(target)" }
    public var date: Date? { parseTimestamp(at) }

    /// The action in words, such as `Idle stage of app`.
    public var title: String {
      let name = URL(fileURLWithPath: target).lastPathComponent
      let what: String
      switch kind {
      case "idle-stage": what = "Idle stage of \(name)"
      case "dormant-stage": what = "Dormant stage of \(name)"
      case "delete-build-outputs": what = "Deleted the build outputs of \(name)"
      case "delete-parked-device": what = "Deleted a parked device"
      case "trim-cache": what = "Trimmed \(name)"
      case "empty-cache": what = "Emptied \(name)"
      case "delete-dependencies": what = "Deleted \(name)"
      case "stop-gradle-daemons": what = "Stopped idle Gradle daemons"
      case "delete-gradle-version": what = "Deleted Gradle \(name)"
      case "delete-temp-leftovers": what = "Deleted TMPDIR leftovers"
      case "delete-trash": what = "Emptied the worktree trash"
      case "reclaim-device": what = "Shut down a device for a waiting run"
      default: what = "\(kind.replacingOccurrences(of: "-", with: " ")) \(name)"
      }
      switch outcome {
      case "would": return "Would: \(what)"
      case "failed": return "Failed: \(what)"
      default: return what
      }
    }
  }

  /// `on`, `report` or `off`.
  public var mode: String
  public var running: Running?
  public var lastTickAt: String?
  public var pressure: Pressure?
  public var recent: [Action]?

  public init(
    mode: String, running: Running? = nil, lastTickAt: String? = nil, pressure: Pressure? = nil,
    recent: [Action]? = nil
  ) {
    self.mode = mode
    self.running = running
    self.lastTickAt = lastTickAt
    self.pressure = pressure
    self.recent = recent
  }

  /// The level of the last tick, `normal` until a daemon with the pressure ladder ticked.
  public var level: String { pressure?.level ?? "normal" }

  /// Whether the last tick measured high or critical pressure.
  public var isRaised: Bool { level == "high" || level == "critical" }

  /// Whether a raised level needs a person: it is critical, or no daemon acts on it.
  public var asksAboutPressure: Bool { isRaised && (level == "critical" || mode != "on" || running == nil) }

  /// The newest actions first, at most `limit`.
  public func lastActions(_ limit: Int = 5) -> [Action] { Array((recent ?? []).reversed().prefix(limit)) }

  /// `Pressure high: 14.2 GB free on /, under disk.minFreeGb (20 GB)`.
  public var headline: String {
    let reasons = pressure?.reasons ?? []
    return "Pressure \(level)" + (reasons.isEmpty ? "" : ": \(reasons.joined(separator: "; "))")
  }
}
