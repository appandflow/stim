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

  public struct LastChecks: Decodable, Hashable, Sendable {
    /// Epoch milliseconds of the last finished-worktree check, nil when none has run.
    public var worktree: Double?
  }

  /// How long the CLI's finished-worktree check may go without running before the app removes them itself.
  public static let worktreeCheckStaleAfter: TimeInterval = 60 * 60

  public var mode: String
  public var invalid: String?
  public var claim: Claim?
  public var lastPass: Pass?
  public var lastChecks: LastChecks?

  public init(
    mode: String, invalid: String? = nil, claim: Claim? = nil, lastPass: Pass? = nil, lastChecks: LastChecks? = nil
  ) {
    self.mode = mode
    self.invalid = invalid
    self.claim = claim
    self.lastPass = lastPass
    self.lastChecks = lastChecks
  }

  /// True when the CLI clears build outputs, trims caches and removes finished worktrees on its own: mode `on`
  /// with valid settings and no unresolved claim blocking its passes. A `stim` without the block or in `report`
  /// mode leaves that cleanup to the app.
  public var cleansAutomatically: Bool { mode == "on" && invalid == nil && claim == nil }

  /// True when the CLI also removes finished worktrees: it cleans automatically and its worktree check ran within
  /// `worktreeCheckStaleAfter`. The check does not run under sustained load or with
  /// `maintenance.removeFinishedWorktrees` false, and then the app keeps removing them.
  public func removesFinishedWorktrees(now: Date) -> Bool {
    guard cleansAutomatically, let last = lastChecks?.worktree else { return false }
    return now.timeIntervalSince(Date(timeIntervalSince1970: last / 1000)) <= Self.worktreeCheckStaleAfter
  }

  /// The last pass as one line, or nil when none has run or it only planned.
  public var lastPassLine: String? {
    guard let pass = lastPass, pass.mode == "on" else { return nil }
    let when = pass.date.formatted(date: .omitted, time: .shortened)
    let actions = pass.actions == 1 ? "1 action" : "\(pass.actions) actions"
    return "Last pass \(when): \(actions), \(Format.fileSize(pass.freedBytes)) freed."
  }
}
