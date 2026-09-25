import Foundation

/// Following `stim status --watch --json`, which prints one status payload
/// per line: one at start, then one per change.
public enum StatusWatch {
  public static let arguments = ["status", "--watch", "--json"]

  /// Whether the watcher's stderr shows a `stim` that predates `--watch`.
  /// commander refuses it with `error: unknown option '--watch'`.
  public static func isUnsupported(stderr: [String]) -> Bool {
    stderr.contains { $0.contains("unknown option") && $0.contains("--watch") }
  }
}

/// The delay before restarting a process that exited: it doubles from
/// `minimum` to `maximum`, and starts over after a run that lasted `maximum`.
public struct RestartBackoff: Sendable {
  public static let minimum: TimeInterval = 1
  public static let maximum: TimeInterval = 30

  private var next = minimum

  public init() {}

  public mutating func delay(afterRunning duration: TimeInterval) -> TimeInterval {
    if duration >= Self.maximum { next = Self.minimum }
    defer { next = min(next * 2, Self.maximum) }
    return next
  }
}
