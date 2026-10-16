import Foundation

/// Reads and changes one simulator's output volume through Xcode's devicectl.
public enum SimulatorAudio {
  public static func read(udid: String) async throws -> Int {
    try parse(await SimulatorOptions.run(["device", "info", "audio", "--device", udid]), udid: udid)
  }

  public static func setVolume(_ volume: Int, udid: String) async throws -> Int {
    guard (0...100).contains(volume) else { throw Failure.unavailable }
    let data = try await SimulatorOptions.run([
      "device", "settings", "audio", "--device", udid, "--volume", String(volume),
    ])
    guard try parse(data, udid: udid) == volume else { throw Failure.unconfirmed }
    let current = try await read(udid: udid)
    guard current == volume else { throw Failure.unconfirmed }
    return current
  }

  static func parse(_ data: Data, udid: String) throws -> Int {
    let response = try JSONDecoder().decode(Response.self, from: data)
    guard response.info.outcome == "success", let result = response.result,
      result.deviceIdentifier.caseInsensitiveCompare(udid) == .orderedSame,
      let volume = result.volume, (0...100).contains(volume)
    else { throw Failure.unavailable }
    return volume
  }

  private struct Response: Decodable {
    struct Info: Decodable { let outcome: String }
    struct Result: Decodable {
      let deviceIdentifier: String
      let volume: Int?
    }
    let info: Info
    let result: Result?
  }

  private enum Failure: LocalizedError {
    case unavailable, unconfirmed

    var errorDescription: String? {
      switch self {
      case .unavailable: return "Sound controls are unavailable for this simulator in the selected Xcode."
      case .unconfirmed: return "Xcode did not confirm the requested volume."
      }
    }
  }
}
