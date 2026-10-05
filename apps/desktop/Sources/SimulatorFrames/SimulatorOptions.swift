import Foundation
import StimKit

public struct SimulatorAppearance: Decodable, Sendable {
  public enum Mode: String, CaseIterable, Decodable, Sendable {
    case light, dark
  }

  public enum TextSize: String, CaseIterable, Sendable {
    case extraSmall = "extra-small"
    case small, medium, large
    case extraLarge = "extra-large"
    case extraExtraLarge = "extra-extra-large"
    case extraExtraExtraLarge = "extra-extra-extra-large"
    case accessibilityMedium = "accessibility-medium"
    case accessibilityLarge = "accessibility-large"
    case accessibilityExtraLarge = "accessibility-extra-large"
    case accessibilityExtraExtraLarge = "accessibility-extra-extra-large"
    case accessibilityExtraExtraExtraLarge = "accessibility-extra-extra-extra-large"

    public var label: String { rawValue.replacingOccurrences(of: "-", with: " ").capitalized }
    public var isAccessibilitySize: Bool { rawValue.hasPrefix("accessibility-") }
  }

  public struct Flag: Decodable, Sendable {
    public let enabled: Bool?
  }

  public let deviceIdentifier: String
  public let userInterfaceStyle: String?
  public let textSize: String?
  public let largerAccessibilitySizesEnabled: Bool?
  public let increaseContrast: Bool?
  public let reduceMotion: Flag?
  public let reduceTransparency: Flag?
  public let showBorders: Flag?

  public var mode: Mode? { userInterfaceStyle.flatMap(Mode.init(rawValue:)) }
  public var size: TextSize? {
    guard let textSize else { return nil }
    let normalized = textSize.lowercased().filter { $0.isLetter }
    return TextSize.allCases.first { $0.rawValue.filter { $0.isLetter } == normalized }
  }
}

/// Reads and changes the selected simulator's appearance through Xcode's devicectl.
public enum SimulatorOptions {
  public enum Change: Sendable {
    case mode(SimulatorAppearance.Mode)
    case textSize(SimulatorAppearance.TextSize)
    case largerSizes(Bool)
    case increaseContrast(Bool)
    case reduceMotion(Bool)
    case reduceTransparency(Bool)
    case showBorders(Bool)

    var arguments: [String] {
      switch self {
      case .mode(let mode): return ["--mode", mode.rawValue]
      case .textSize(let size): return ["--text-size", size.rawValue]
      case .largerSizes(let enabled): return ["--larger-accessibility-sizes", enabled ? "on" : "off"]
      case .increaseContrast(let enabled): return ["--increase-contrast", enabled ? "on" : "off"]
      case .reduceMotion(let enabled): return ["--reduce-motion", enabled ? "on" : "off"]
      case .reduceTransparency(let enabled): return ["--reduce-transparency", enabled ? "on" : "off"]
      case .showBorders(let enabled): return ["--show-borders", enabled ? "on" : "off"]
      }
    }
  }

  public static func read(udid: String) async throws -> SimulatorAppearance {
    let data = try await run(["device", "info", "appearance", "--device", udid])
    return try parse(data, udid: udid)
  }

  public static func apply(_ change: Change, udid: String) async throws -> SimulatorAppearance {
    let data = try await run(["device", "settings", "appearance", "--device", udid] + change.arguments)
    let response = try JSONDecoder().decode(Outcome.self, from: data)
    guard response.info.outcome == "success" else { throw Failure.unsuccessful }
    return try await read(udid: udid)
  }

  static func parse(_ data: Data, udid: String) throws -> SimulatorAppearance {
    let response = try JSONDecoder().decode(Response.self, from: data)
    guard response.info.outcome == "success", let appearance = response.result else { throw Failure.unsuccessful }
    guard appearance.deviceIdentifier.caseInsensitiveCompare(udid) == .orderedSame else { throw Failure.wrongDevice }
    return appearance
  }

  private struct Outcome: Decodable {
    struct Info: Decodable { let outcome: String }
    let info: Info
  }

  private struct Response: Decodable {
    let info: Outcome.Info
    let result: SimulatorAppearance?
  }

  private static func run(_ arguments: [String]) async throws -> Data {
    try Task.checkCancellation()
    var environment = ProcessInfo.processInfo.environment
    environment["DEVELOPER_DIR"] = CoreSimulator.developerDir
    var request = ProcessRequest(
      "/usr/bin/xcrun", ["devicectl"] + arguments + ["--timeout", "5", "--json-output", "-"],
      cwd: "/", environment: environment, timeout: 8
    )
    request.captureStderr = true
    let result = try await request.run()
    guard result.succeeded else { throw Failure.command(result.stderrText.trimmingCharacters(in: .whitespacesAndNewlines)) }
    return result.stdout
  }

  private enum Failure: LocalizedError {
    case unsuccessful, wrongDevice
    case command(String)

    var errorDescription: String? {
      switch self {
      case .unsuccessful: return "Xcode did not report the simulator's appearance settings."
      case .wrongDevice: return "Xcode returned settings for a different device."
      case .command(let reason): return reason.isEmpty ? "Simulator options are unavailable in this Xcode or runtime." : reason
      }
    }
  }
}
