import Foundation

/// The gRPC endpoint a running Android emulator advertises in its discovery file.
public struct EmulatorEndpoint: Equatable, Sendable {
  public var consolePort: Int
  public var grpcPort: Int
  public var token: String?
}

public enum EmulatorDiscovery {
  // The emulator writes pid_<pid>.ini here on macOS, ignoring XDG_RUNTIME_DIR,
  // and only when it was started with -grpc. `adb emu avd discoverypath`
  // prints the same path.
  static var directory: URL {
    FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Caches/TemporaryItems/avd/running", isDirectory: true)
  }

  public static func parse(_ contents: String) -> EmulatorEndpoint? {
    var values: [Substring: Substring] = [:]
    for line in contents.split(whereSeparator: \.isNewline) {
      guard let separator = line.firstIndex(of: "=") else { continue }
      values[line[..<separator]] = line[line.index(after: separator)...]
    }
    guard let console = values["port.serial"].flatMap({ Int($0) }),
      let grpc = values["grpc.port"].flatMap({ Int($0) })
    else { return nil }
    return EmulatorEndpoint(consolePort: console, grpcPort: grpc, token: values["grpc.token"].map(String.init))
  }

  public static func consolePort(serial: String) -> Int? {
    guard serial.hasPrefix("emulator-") else { return nil }
    return Int(serial.dropFirst("emulator-".count))
  }

  public static func endpoint(serial: String) -> EmulatorEndpoint? {
    guard let console = consolePort(serial: serial),
      let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path)
    else { return nil }
    for name in names where name.hasPrefix("pid_") && name.hasSuffix(".ini") {
      guard let pid = Int32(name.dropFirst(4).dropLast(4)), kill(pid, 0) == 0,
        let contents = try? String(contentsOf: directory.appendingPathComponent(name), encoding: .utf8),
        let endpoint = parse(contents), endpoint.consolePort == console
      else { continue }
      return endpoint
    }
    return nil
  }
}
