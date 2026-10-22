import Foundation

/// The `maintenance` block of `stim status --json`: the CLI's automatic resource maintenance.
public struct MaintenanceStatus: Decodable, Hashable, Sendable {
  public struct Pass: Decodable, Hashable, Sendable {
    /// Epoch milliseconds.
    public var startedAt: Double
    public var mode: String
    public var freedBytes: Int64
    public var actions: Int
    public var blocked: [String]

    public var date: Date { Date(timeIntervalSince1970: startedAt / 1000) }
  }

  public struct Claim: Decodable, Hashable, Sendable {}

  /// A process whose physical footprint the CLI found abnormal while memory pressure was warning or critical.
  /// `command` safely restarts or stops it; it is nil when the CLI knows no safe restart.
  public struct MemoryCulprit: Decodable, Hashable, Sendable, Identifiable {
    public var pid: Int
    public var name: String
    public var bytes: Int64
    public var command: String?
    public var note: String?

    public var id: Int { pid }
  }

  public struct Pressure: Decodable, Hashable, Sendable {
    public struct Memory: Decodable, Hashable, Sendable {
      public var culprits: [MemoryCulprit]?
    }

    public var memory: Memory?
  }

  public var mode: String
  public var invalid: String?
  public var claim: Claim?
  public var lastPass: Pass?
  public var pressure: Pressure?

  public var memoryCulprits: [MemoryCulprit] { pressure?.memory?.culprits ?? [] }

  public init(mode: String, invalid: String? = nil, claim: Claim? = nil, lastPass: Pass? = nil) {
    self.mode = mode
    self.invalid = invalid
    self.claim = claim
    self.lastPass = lastPass
  }

  /// True when the CLI cleans up on its own: mode `on` with valid settings and no unresolved claim blocking its
  /// passes. A `stim` without the block, or in `report` or `off` mode, cleans up nothing by itself.
  public var cleansAutomatically: Bool { mode == "on" && invalid == nil && claim == nil }

  /// Whether free disk under the budget needs a person: the CLI does not clean up on its own, or its last pass
  /// was blocked.
  public static func asksAboutDiskPressure(_ status: MaintenanceStatus?) -> Bool {
    guard let status, status.cleansAutomatically else { return true }
    return !(status.lastPass?.blocked.isEmpty ?? true)
  }
}
