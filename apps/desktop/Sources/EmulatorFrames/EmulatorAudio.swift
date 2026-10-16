import Foundation
import StimKit

/// Controls Android's STREAM_MUSIC volume on one emulator; alarm and ringtone streams are independent.
public enum EmulatorAudio {
  public struct Volume: Sendable {
    public let current: Int
    public let maximum: Int
  }

  public static func read(serial: String, avdName: String) async throws -> Volume {
    try parse(await run(serial: serial, avdName: avdName, arguments: ["media_session", "volume", "--stream", "3", "--get"]))
  }

  public static func setVolume(_ volume: Int, serial: String, avdName: String) async throws -> Volume {
    guard volume >= 0 else { throw Failure.unavailable }
    _ = try await run(serial: serial, avdName: avdName, arguments: ["audio", "set-volume", "3", String(volume)])
    let result = try await read(serial: serial, avdName: avdName)
    guard result.current == volume else { throw Failure.unconfirmed }
    return result
  }

  static func parse(_ data: Data) throws -> Volume {
    let text = String(decoding: data, as: UTF8.self)
    let expression = try NSRegularExpression(pattern: #"\bvolume is ([0-9]+) in range \[0\.\.([0-9]+)\]"#)
    guard let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
      let currentRange = Range(match.range(at: 1), in: text),
      let maximumRange = Range(match.range(at: 2), in: text),
      let current = Int(text[currentRange]), let maximum = Int(text[maximumRange]),
      maximum > 0, (0...maximum).contains(current)
    else { throw Failure.unavailable }
    return Volume(current: current, maximum: maximum)
  }

  private static func run(serial: String, avdName: String, arguments: [String]) async throws -> Data {
    guard serial.hasPrefix("emulator-"), let port = Int(serial.dropFirst(9)), (1...65535).contains(port) else {
      throw Failure.unavailable
    }
    let identity = try await ProcessRequest(AdbInput.adbPath, ["-s", serial, "emu", "avd", "name"], timeout: 8).run()
    guard identity.succeeded, identity.stdoutText.components(separatedBy: .newlines).first == avdName else {
      throw Failure.unavailable
    }
    let request = ProcessRequest(
      AdbInput.adbPath,
      ["-s", serial, "shell", "cmd"] + arguments,
      timeout: 8
    )
    let result = try await request.run()
    guard result.succeeded else { throw Failure.unavailable }
    return result.stdout
  }

  private enum Failure: LocalizedError {
    case unavailable, unconfirmed

    var errorDescription: String? {
      switch self {
      case .unavailable: return "Media sound controls are unavailable for this emulator."
      case .unconfirmed: return "Android did not confirm the requested media volume."
      }
    }
  }
}
