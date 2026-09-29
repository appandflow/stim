import Foundation

/// The parts of stim-server's WebSocket protocol (`packages/server/src/protocol.ts`) that Stim Desktop speaks.
public enum ServerProtocol {
  public static let version = 1
  /// Error codes that refuse the client until it pairs again or updates; clients retry the others.
  public static let refusalCodes: Set<String> = ["unauthorized", "pairing-expired", "protocol-unsupported"]
}

/// An error answer, or a subscription's `error` event.
public struct ServerError: Error, Equatable, Sendable, LocalizedError, Decodable {
  public var code: String
  public var message: String

  public init(code: String, message: String) {
    self.code = code
    self.message = message
  }

  public var errorDescription: String? { message }
  public var refusesClient: Bool { ServerProtocol.refusalCodes.contains(code) }
}

/// How `hello` authenticates: a device token from an earlier pairing, or a single-use pairing token to spend.
public enum ServerAuth: Equatable, Sendable {
  case device(token: String)
  case pairing(token: String, deviceName: String)

  var json: JSONValue {
    switch self {
    case .device(let token): return .object(["deviceToken": .string(token)])
    case .pairing(let token, let name): return .object(["pairingToken": .string(token), "deviceName": .string(name)])
    }
  }
}

public struct HelloResult: Decodable, Equatable, Sendable {
  public struct Server: Decodable, Equatable, Sendable {
    public var name: String
    public var version: String
    public var stim: String
  }

  public struct Device: Decodable, Equatable, Sendable {
    public var id: String
    public var name: String
  }

  public var protocolVersion: Int
  public var server: Server
  public var capabilities: [String]
  /// What the server serves beyond the base protocol, such as `physical-android`; nil from a server older than it.
  public var features: [String]?
  public var device: Device?
  /// Present only when the hello spent a pairing token.
  public var deviceToken: String?

  enum CodingKeys: String, CodingKey {
    case server, capabilities, features, device, deviceToken
    case protocolVersion = "protocol"
  }
}

/// A device slot of a workspace, as `replay.range` and `frames.subscribe` name it.
public struct ReplayTarget: Hashable, Sendable {
  public var workspace: String
  public var platform: String
  public var slot: String

  public init(workspace: String, platform: String, slot: String) {
    self.workspace = workspace
    self.platform = platform
    self.slot = slot
  }

  var params: [String: JSONValue] {
    ["workspace": .string(workspace), "platform": .string(platform), "slot": .string(slot)]
  }
}

/// A time range with recorded footage, in epoch milliseconds on the Mac's clock.
public struct ReplaySpan: Decodable, Equatable, Sendable {
  public var start: Double
  public var end: Double

  public init(start: Double, end: Double) {
    self.start = start
    self.end = end
  }
}

/// An agent `action` on the device, an app or build `error`, or a `crash`, at `at`.
public struct ReplayMarker: Decodable, Equatable, Hashable, Sendable {
  public var at: Double
  public var kind: String
  public var command: String?
  public var label: String

  public init(at: Double, kind: String, command: String? = nil, label: String) {
    self.at = at
    self.kind = kind
    self.command = command
    self.label = label
  }

  public var title: String {
    switch kind {
    case "action": return "Agent"
    case "crash": return "Crash"
    default: return "Error"
    }
  }
}

/// What can be replayed for a device slot. `enabled` is the workspace's `recording.enabled`; `recording` is true
/// while the server records the device now.
public struct ReplayRange: Decodable, Equatable, Sendable {
  public var enabled: Bool
  public var recording: Bool
  public var spans: [ReplaySpan]
  public var markers: [ReplayMarker]

  public init(enabled: Bool, recording: Bool, spans: [ReplaySpan], markers: [ReplayMarker]) {
    self.enabled = enabled
    self.recording = recording
    self.spans = spans
    self.markers = markers
  }
}

/// The keyframe that starts a recorded segment of about 5 seconds, from `replay.keyframe`: the segment's `start`
/// and `end`, the keyframe's capture time `at`, and its Annex-B access unit, which carries its SPS and PPS.
public struct ReplayKeyframe: Equatable, Sendable {
  public var start: Double
  public var end: Double
  public var at: Double
  public var width: Int
  public var height: Int
  public var accessUnit: Data

  public init(start: Double, end: Double, at: Double, width: Int, height: Int, accessUnit: Data) {
    self.start = start
    self.end = end
    self.at = at
    self.width = width
    self.height = height
    self.accessUnit = accessUnit
  }

  /// Nil for a result missing a field or with `data` that is not base64.
  public init?(_ result: JSONValue) {
    guard case .object(let fields) = result, let start = fields["start"]?.number, let end = fields["end"]?.number,
      let at = fields["at"]?.number, let width = fields["width"]?.number, let height = fields["height"]?.number,
      let data = fields["data"]?.string, let accessUnit = Data(base64Encoded: data)
    else { return nil }
    self.init(start: start, end: end, at: at, width: Int(width), height: Int(height), accessUnit: accessUnit)
  }
}

/// One binary video message: a header, then one Annex-B H.264 access unit. A keyframe carries its SPS and PPS.
public struct VideoPacket: Equatable, Sendable {
  public var subscription: String
  public var keyframe: Bool
  public var sequence: UInt32
  /// Capture time in epoch milliseconds on the Mac's clock.
  public var capturedAt: Double
  public var width: Int
  public var height: Int
  public var accessUnit: Data

  /// Parses the big-endian layout `VideoPacket` documents: u8 version 1, u8 flags, u16 header length, u32 sequence,
  /// f64 capture time, u16 width, u16 height, u8 id length N, N bytes of subscription id. Nil for another version
  /// or a message too short for its header.
  public init?(_ data: Data) {
    let bytes = [UInt8](data)
    guard bytes.count >= 21, bytes[0] == 1 else { return nil }
    func u16(_ at: Int) -> Int { Int(bytes[at]) << 8 | Int(bytes[at + 1]) }
    let headerLength = u16(2)
    let idLength = Int(bytes[20])
    guard headerLength >= 21 + idLength, bytes.count >= headerLength else { return nil }
    keyframe = bytes[1] & 1 != 0
    sequence = bytes[4..<8].reduce(0) { $0 << 8 | UInt32($1) }
    capturedAt = Double(bitPattern: bytes[8..<16].reduce(0) { $0 << 8 | UInt64($1) })
    width = u16(16)
    height = u16(18)
    guard let id = String(bytes: bytes[21..<(21 + idLength)], encoding: .ascii) else { return nil }
    subscription = id
    accessUnit = Data(bytes[headerLength...])
  }
}

/// A server event for a subscription, with its fields as JSON.
public struct ServerEvent: Equatable, Sendable {
  public var name: String
  public var subscription: String
  public var fields: [String: JSONValue]

  public init(name: String, subscription: String, fields: [String: JSONValue]) {
    self.name = name
    self.subscription = subscription
    self.fields = fields
  }

  /// The `error` of an `error` event.
  public var error: ServerError? {
    guard name == "error", case .object(let error)? = fields["error"], let code = error["code"]?.string else {
      return nil
    }
    return ServerError(code: code, message: error["message"]?.string ?? code)
  }
}

/// The server ended a control session: `idle`, `taken-over`, `device-gone`, `forbidden` or `failed`, with its
/// message. `session` is nil when the connection dropped, which ends every session it held.
public struct ControlEnded: Equatable, Sendable {
  public var session: String?
  public var reason: String
  public var message: String

  public init(session: String?, reason: String, message: String) {
    self.session = session
    self.reason = reason
    self.message = message
  }
}
