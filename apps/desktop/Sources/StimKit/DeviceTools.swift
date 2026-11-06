import Foundation

/// A change to the workspace's owned local virtual device.
public enum DeviceTool: Sendable, Equatable {
  public enum PermissionAction: String, Sendable, CaseIterable {
    case grant, revoke, reset
  }

  case setLocation(latitude: Double, longitude: Double)
  case clearLocation
  case permission(PermissionAction, service: String)
  case push(payload: String)
  case network(enabled: Bool)

  public static let iosServices = [
    "calendar", "contacts", "contacts-limited", "location", "location-always", "media-library", "microphone",
    "motion", "photos", "photos-add", "reminders", "siri",
  ]
  public static let androidServices = [
    "calendar", "camera", "contacts", "location", "microphone", "motion", "notifications", "photos",
  ]

  public static func services(platform: String) -> [String] {
    platform == "ios" ? iosServices : androidServices
  }

  /// A latitude and longitude typed as `lat, lng`, or nil when either is missing or out of range.
  public static func parseCoordinate(_ text: String) -> (latitude: Double, longitude: Double)? {
    let parts = text.split(separator: ",", omittingEmptySubsequences: false).map {
      $0.trimmingCharacters(in: .whitespaces)
    }
    guard parts.count == 2, let latitude = Double(parts[0]), let longitude = Double(parts[1]),
      abs(latitude) <= 90, abs(longitude) <= 180
    else { return nil }
    return (latitude, longitude)
  }

  public func remedyParams(platform: String, slot: String, cwd: String) -> [String: JSONValue] {
    var request: [String: JSONValue] = ["platform": .string(platform)]
    switch self {
    case .setLocation(let latitude, let longitude):
      request["tool"] = .string("location")
      request["set"] = .string(String(format: "%.6f,%.6f", latitude, longitude))
    case .clearLocation:
      request["tool"] = .string("location")
      request["clear"] = .bool(true)
    case .permission(let action, let service):
      request["tool"] = .string("permission")
      request["action"] = .string(action.rawValue)
      request["service"] = .string(service)
    case .push(let payload):
      request["tool"] = .string("push")
      request["payload"] = .string(payload)
    case .network(let enabled):
      request["tool"] = .string("network")
      request["state"] = .string(enabled ? "on" : "off")
    }
    var params: [String: JSONValue] = ["action": .string("device-tool"), "cwd": .string(cwd), "request": .object(request)]
    if slot != DeviceRef.defaultSlot { params["slot"] = .string(slot) }
    return params
  }
}

/// The result of a device change and its optional read-back state.
public struct DeviceToolResult: Decodable, Sendable, Equatable {
  public struct Permission: Decodable, Sendable, Equatable {
    public let name: String
    public let granted: Bool
  }
  public struct ReadBack: Decodable, Sendable, Equatable {
    public let permissions: [Permission]?
    public let wifi: Bool?
    public let data: Bool?
  }

  public let tool: String
  public let action: String?
  public let service: String?
  public let deviceName: String
  public let enabled: Bool?
  public let readBack: ReadBack?

  private static let pastTense = ["grant": "granted", "revoke": "revoked", "reset": "reset"]

  /// One line for the Tools section: what changed, and what the device reported afterwards when it can say.
  public var summary: String {
    switch tool {
    case "location": return action == "clear" ? "Location cleared." : "Location set."
    case "permission":
      let name = service ?? "Permission"
      let state = Self.pastTense[action ?? ""] ?? "changed"
      if let permissions = readBack?.permissions, !permissions.isEmpty { return "\(name) \(state), as the device reports." }
      return "\(name) \(state)."
    case "push": return "Push sent."
    case "network":
      guard let wifi = readBack?.wifi, let data = readBack?.data else { return "Network changed." }
      return "Wi-Fi \(wifi ? "on" : "off"), mobile data \(data ? "on" : "off"), as the device reports."
    default: return "Done."
    }
  }
}

/// A device-tool refusal with its message and recovery instructions.
public struct DeviceToolError: LocalizedError, Equatable {
  public let message: String

  public init(stdout: Data, stderr: String) {
    struct Refusal: Decodable {
      let message: String
      let remedy: String?
    }
    if let refusal = try? JSONDecoder().decode(Refusal.self, from: stdout) {
      message = [refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " ")
      return
    }
    let lines = stderr.split(separator: "\n").map(String.init)
    let first = lines.first.map { line -> String in
      guard let colon = line.range(of: ": "), line.hasPrefix("STIM_") else { return line }
      return String(line[colon.upperBound...])
    }
    message = ([first].compactMap { $0 } + lines.dropFirst()).joined(separator: " ")
  }

  public var errorDescription: String? { message.isEmpty ? "The device tool failed." : message }
}

/// Runs a typed device change through the private same-home Desktop server and awaits its cleanup acknowledgement.
@MainActor public func runServerDeviceTool(
  _ tool: DeviceTool, platform: String, slot: String, cwd: String, stimHome: String,
  connection: (client: ServerClient, home: String)?
) async throws -> DeviceToolResult {
  let result = try await runServerRemedy(
    params: tool.remedyParams(platform: platform, slot: slot, cwd: cwd), stimHome: stimHome,
    connection: connection, json: true)
  guard result.exitStatus == 0 else { throw DeviceToolError(stdout: result.stdout, stderr: result.message) }
  return try JSONDecoder().decode(DeviceToolResult.self, from: result.stdout)
}
