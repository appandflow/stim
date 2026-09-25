import Foundation

/// The Tailscale state `stim-server` reports: `running`, `not-running` with the backend state, or
/// `unavailable` with a reason.
public struct TailscaleState: Decodable, Equatable, Sendable {
  public var state: String
  public var dnsName: String?
  public var backendState: String?
  public var reason: String?

  public var isRunning: Bool { state == "running" }

  public var summary: String {
    switch state {
    case "running": return dnsName.map { "Tailscale is running as \($0)." } ?? "Tailscale is running."
    case "not-running": return "Tailscale is not running (\(backendState ?? "unknown state"))."
    default: return "Tailscale is unavailable: \(reason ?? "unknown reason")."
    }
  }
}

/// `GET /health` on the server's loopback port.
public struct ServerHealth: Decodable, Equatable, Sendable {
  public var server: String
  public var name: String
  public var version: String
  public var stim: String
  public var protocolVersion: Int
  /// The `STIM_HOME` the server keeps its pairing state under.
  public var stimHome: String
  public var tailscale: TailscaleState

  enum CodingKeys: String, CodingKey {
    case server, name, version, stim, stimHome, tailscale
    case protocolVersion = "protocol"
  }
}

/// `stim-server pair --json`: the QR payload and when its single-use token expires.
public struct PairingCode: Decodable, Equatable, Sendable {
  public struct QR: Codable, Equatable, Sendable {
    public var v: Int
    public var name: String
    public var endpoint: String
    public var pairingToken: String
  }

  public var qr: QR
  public var expiresAt: Date

  /// The JSON text the QR code encodes.
  public var qrText: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: (try? encoder.encode(qr)) ?? Data(), as: UTF8.self)
  }

  /// A `ws://` loopback endpoint, which only a client on this Mac can reach.
  public var isLocalOnly: Bool { qr.endpoint.hasPrefix("ws://127.0.0.1") }
}

/// A device in `stim-server devices --json`.
public struct PairedDevice: Decodable, Equatable, Identifiable, Sendable {
  public struct Identity: Decodable, Equatable, Sendable {
    public var kind: String
    public var nodeName: String?
    public var nodeId: String?
    public var user: String?
  }

  public var id: String
  public var name: String
  public var identity: Identity
  public var pairedAt: Date
  public var lastSeenAt: Date?

  /// The tailnet node the device paired from, or this Mac for a loopback pairing.
  public var node: String {
    guard identity.kind == "tailnet" else { return "This Mac" }
    let node = identity.nodeName.flatMap { $0.isEmpty ? nil : $0 } ?? identity.nodeId ?? "unknown node"
    return identity.user.flatMap { $0.isEmpty ? nil : "\(node) (\($0))" } ?? node
  }
}

struct PairedDeviceList: Decodable {
  var devices: [PairedDevice]
}

/// Runs `stim-server`, which serves Stim state to paired phones over Tailscale.
public struct StimServerCLI: Sendable {
  public static let defaultPort = 7787

  /// The override or the first `stim-server` on the environment's `PATH`.
  public let executable: String?
  public let environment: [String: String]

  public init(environment: [String: String], override: String? = nil) {
    var environment = environment
    self.executable = resolveExecutable("stim-server", override: override, environment: &environment)
    self.environment = environment
  }

  public enum Failure: LocalizedError {
    case notFound
    case exited(Int32, String)

    public var errorDescription: String? {
      switch self {
      case .notFound:
        return "Could not find stim-server. Install @stim-cli/server globally or choose it in Settings."
      case .exited(let code, let stderr):
        return stderr.isEmpty ? "stim-server exited with status \(code)." : stderr
      }
    }
  }

  static let decoder: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let text = try decoder.singleValueContainer().decode(String.self)
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text) { return date }
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a date: \(text)"))
    }
    return decoder
  }()

  public func pair(port: Int = defaultPort) throws -> PairingCode {
    try Self.decoder.decode(PairingCode.self, from: run(["pair", "--json", "--port", String(port)]))
  }

  public func devices() throws -> [PairedDevice] {
    try Self.decoder.decode(PairedDeviceList.self, from: run(["devices", "--json"])).devices
  }

  public func revoke(_ id: String) throws {
    _ = try run(["devices", "revoke", id])
  }

  /// Starts the server on `port`; it runs until terminated.
  public func serve(
    port: Int = defaultPort,
    onLine: @escaping @Sendable (OutputLine) -> Void,
    onExit: @escaping @Sendable (Int32) -> Void
  ) throws -> Process {
    guard let executable else { throw Failure.notFound }
    return try ProcessStream.start(
      executable: executable, arguments: ["--port", String(port)], cwd: NSHomeDirectory(),
      environment: environment, onLine: onLine, onExit: onExit)
  }

  /// The server answering on `port` of this Mac, or nil when none does.
  public static func health(port: Int = defaultPort) async -> ServerHealth? {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/health")!)
    request.timeoutInterval = 2
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      (response as? HTTPURLResponse)?.statusCode == 200,
      let health = try? decoder.decode(ServerHealth.self, from: data),
      health.server == "stim-server"
    else { return nil }
    return health
  }

  private func run(_ args: [String]) throws -> Data {
    guard let executable else { throw Failure.notFound }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = args
    process.environment = environment
    let out = Pipe()
    let err = Pipe()
    process.standardOutput = out
    process.standardError = err
    try process.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    let stderr = err.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      throw Failure.exited(
        process.terminationStatus,
        String(decoding: stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
    }
    return data
  }
}
