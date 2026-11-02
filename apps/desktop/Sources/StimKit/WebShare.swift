import Foundation

/// A live web share, as `share.list` lists it. The server never sends a share's link token or password.
public struct WebShare: Codable, Equatable, Identifiable, Sendable {
  public enum Auth: String, Codable, Sendable {
    case generated, set, none
  }

  public var id: String
  public var workspace: String
  public var platform: String
  public var slot: String
  public var physical: Bool
  public var control: Bool
  public var expiresAt: String
  public var viewers: Int
  public var auth: Auth

  /// "42m left", "1h05m left", "<1m left", or "Expired" once the share is past its expiry.
  public func timeLeft(now: Date = Date()) -> String {
    guard let end = parseTimestamp(expiresAt) else { return expiresAt }
    let seconds = end.timeIntervalSince(now)
    return seconds <= 0 ? "Expired" : "\(Format.duration(seconds)) left"
  }

  public var platformLabel: String {
    let name = platform == "ios" ? "iOS" : platform == "android" ? "Android" : platform
    return slot == DeviceRef.defaultSlot ? name : "\(name) (\(slot))"
  }

  public var accessLabel: String { control ? "View and control" : "View only" }

  public var viewersLabel: String { "\(viewers) viewer\(viewers == 1 ? "" : "s")" }
}

public struct WebSharesPayload: Codable, Equatable, Sendable {
  public var shares: [WebShare]
}

/// What `share.start` answers: the share, its link, and the password only when the server generated one.
public struct StartedWebShare: Decodable, Equatable, Sendable {
  public var share: WebShare
  public var url: String
  public var password: String?

  public init(from decoder: Decoder) throws {
    share = try WebShare(from: decoder)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    url = try container.decode(String.self, forKey: .url)
    password = try container.decodeIfPresent(String.self, forKey: .password)
  }

  private enum CodingKeys: String, CodingKey { case url, password }
}

/// The choices of `stim share ios|android`, and the `share.start` parameters they make.
public struct WebShareOptions: Equatable, Sendable {
  public enum Password: Equatable, Sendable {
    case generated
    case custom(String)
    case none
  }

  public static let defaultMinutes = 60
  public static let maxMinutes = 480
  public static let passwordLengths = 8...128

  public var control = false
  public var minutes = WebShareOptions.defaultMinutes
  public var password = Password.generated

  public init() {}

  /// Why these options cannot start a share, or nil.
  public var problem: String? {
    guard (1...Self.maxMinutes).contains(minutes) else {
      return "Choose 1 to \(Self.maxMinutes) minutes."
    }
    if case .custom(let value) = password, !Self.passwordLengths.contains(value.count) {
      return "A password is \(Self.passwordLengths.lowerBound) to \(Self.passwordLengths.upperBound) characters."
    }
    return nil
  }

  public func params(workspace: String, platform: String, slot: String) -> [String: JSONValue] {
    var params: [String: JSONValue] = [
      "workspace": .string(workspace), "platform": .string(platform), "control": .bool(control),
      "expiresMinutes": .number(Double(minutes)),
    ]
    if slot != DeviceRef.defaultSlot { params["slot"] = .string(slot) }
    switch password {
    case .generated: break
    case .custom(let value): params["password"] = .string(value)
    case .none: params["passwordless"] = .bool(true)
    }
    return params
  }
}

/// The confirmation Stim Desktop shows before it quits while its own stim-server holds live web shares.
public struct WebShareQuitPrompt: Equatable, Sendable {
  public var title: String
  public var lines: [String]

  /// Nil when no share is live. `name` gives a workspace's display name.
  public init?(shares: [WebShare], now: Date = Date(), name: (String) -> String) {
    guard !shares.isEmpty else { return nil }
    title = shares.count == 1 ? "Quitting ends 1 web share." : "Quitting ends \(shares.count) web shares."
    lines = shares.map {
      "\(name($0.workspace)), \($0.platformLabel): \($0.accessLabel.lowercased()), \($0.viewersLabel), \($0.timeLeft(now: now))"
    }
  }

  public static let detail = "Viewers are cut off and the links stop working. Stim Desktop runs the server that holds them."
}
