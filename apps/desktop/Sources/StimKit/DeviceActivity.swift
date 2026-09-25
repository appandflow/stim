import Foundation

/// `activity` on a booted simulator or detected emulator in `stim status --json`.
public struct DeviceActivity: Decodable, Hashable, Sendable {
  public struct Driver: Decodable, Hashable, Sendable {
    public var tool: String
    public var pid: Int?
    public var since: String?
  }

  public var state: String
  public var driver: Driver?
  public var lastActivityAt: String?
  public var basis: [String]
}

/// What a device tile says about who is using the device.
public enum ActivityBadge: Equatable, Sendable {
  case driven(tool: String, since: TimeInterval?)
  case idle(TimeInterval?)
  case unknown

  /// The CLI's window for "active": activity in the last 10 minutes.
  public static let activeWindow: TimeInterval = 10 * 60

  /// `screenChangedAt` is when this app last saw the device's screen change. The CLI cannot see screen
  /// changes, so a recent one overrides its "idle".
  public init?(_ activity: DeviceActivity?, screenChangedAt: Date? = nil, now: Date = Date()) {
    guard let activity else { return nil }
    switch activity.state {
    case "driven":
      let since = activity.driver?.since.flatMap(Self.date).map { max(0, now.timeIntervalSince($0)) }
      self = .driven(tool: activity.driver?.tool ?? "an unknown tool", since: since)
    case "idle":
      let last = [activity.lastActivityAt.flatMap(Self.date), screenChangedAt].compactMap { $0 }.max()
      if let last, now.timeIntervalSince(last) < Self.activeWindow { return nil }
      self = .idle(last.map { max(0, now.timeIntervalSince($0)) })
    case "unknown":
      self = .unknown
    default:
      return nil
    }
  }

  public var text: String {
    switch self {
    case .driven(let tool, let since):
      return since.map { "Driven by \(tool) \u{00B7} \(Self.duration($0))" } ?? "Driven by \(tool)"
    case .idle(let idle):
      return idle.map { "Idle \(Self.duration($0))" } ?? "Idle"
    case .unknown:
      return "Activity unknown"
    }
  }

  static func duration(_ seconds: TimeInterval) -> String {
    let minutes = Int(seconds / 60)
    if minutes < 1 { return "<1m" }
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return minutes % 60 == 0 ? "\(hours)h" : "\(hours)h\(String(format: "%02d", minutes % 60))m" }
    return "\(hours / 24)d"
  }

  private static func date(_ text: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
  }
}

/// When the app last saw each device's screen change, keyed by simulator UDID or emulator serial.
public final class ScreenActivity: @unchecked Sendable {
  public static let shared = ScreenActivity()
  private let lock = NSLock()
  private var changed: [String: Date] = [:]

  public init() {}

  public func record(_ id: String, at date: Date = Date()) {
    lock.lock()
    changed[id] = date
    lock.unlock()
  }

  public func lastChange(_ id: String) -> Date? {
    lock.lock()
    defer { lock.unlock() }
    return changed[id]
  }
}
