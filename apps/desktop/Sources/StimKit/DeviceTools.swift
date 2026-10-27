import Foundation

/// One change the device viewer's Tools section asks `stim device` to make to the workspace's own simulator or
/// emulator. The CLI owns the ownership check and the tool calls; Desktop only builds the arguments and reads the
/// JSON it prints.
public enum DeviceTool: Sendable, Equatable {
  public enum PermissionAction: String, Sendable, CaseIterable {
    case grant, revoke, reset
  }

  case setLocation(latitude: Double, longitude: Double)
  case clearLocation
  case permission(PermissionAction, service: String)
  case push(payload: String)
  case network(enabled: Bool)

  /// The `stim` release that added `stim device location|permission|push|network`.
  public static let minimumCLIVersion = "1.30.0"

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

  public func arguments(platform: String, slot: String) -> [String] {
    var arguments: [String]
    switch self {
    case .setLocation(let latitude, let longitude):
      arguments = [
        "device", "location", platform, "--set", String(format: "%.6f,%.6f", latitude, longitude),
      ]
    case .clearLocation:
      arguments = ["device", "location", platform, "--clear"]
    case .permission(let action, let service):
      arguments = ["device", "permission", platform, action.rawValue, service]
    case .push(let payload):
      arguments = ["device", "push", platform, "--payload", payload]
    case .network(let enabled):
      arguments = ["device", "network", platform, enabled ? "on" : "off"]
    }
    if slot != DeviceRef.defaultSlot { arguments += ["--slot", slot] }
    return arguments + ["--json"]
  }
}

/// The single JSON line `stim device location|permission|push|network --json` prints.
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

/// A refusal or failure `stim device` printed: its message and remedy, without the code and the exit status. With
/// `--json` the CLI prints the whole refusal as one JSON line on stdout, which survives a message that spans lines.
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
    if stderr.contains("unknown command") {
      message = "This version of stim has no device tools. Update stim to \(DeviceTool.minimumCLIVersion) or later."
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

extension StimCLI {
  /// Runs one device tool in `cwd`, the workspace whose own simulator or emulator it changes.
  public func deviceTool(_ tool: DeviceTool, platform: String, slot: String, cwd: String) async throws
    -> DeviceToolResult
  {
    let (status, data, stderr) = try await execute(
      tool.arguments(platform: platform, slot: slot), cwd: cwd, timeout: 60)
    guard status == 0 else { throw DeviceToolError(stdout: data, stderr: stderr) }
    return try JSONDecoder().decode(DeviceToolResult.self, from: data)
  }
}
