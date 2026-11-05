import Foundation

public struct HostedSessionsPayload: Codable, Equatable, Sendable {
  public var sessions: [HostedSession]
}

public struct HostedSession: Codable, Equatable, Identifiable, Sendable {
  public struct Client: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
  }

  public enum Platform: String, Codable, Sendable {
    case ios, android, macos
  }

  public enum State: String, Codable, Sendable {
    case preparing, ready, stopping, stopped, unknown

    public init(from decoder: Decoder) throws {
      let value = try decoder.singleValueContainer().decode(String.self)
      self = State(rawValue: value) ?? .unknown
    }
  }

  public var id: String
  public var client: Client
  public var platform: Platform
  public var device: String?
  public var app: String?
  public var state: State
  public var parked: Bool
  public var since: String
  public var workspace: String

  public var stateLabel: String {
    if parked { return "Parked" }
    switch state {
    case .preparing: return "Preparing"
    case .ready: return "Running"
    case .stopping: return "Stopping"
    case .stopped: return "Stopped"
    case .unknown: return "Needs attention"
    }
  }

  public func sinceText(now: Date = Date()) -> String {
    guard let date = parseTimestamp(since) else { return since }
    return "\(Format.since(now.timeIntervalSince(date))) ago"
  }
}
