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

/// How the Mac's `tailscale serve` config reaches the server: `routed` on a tailnet-only HTTPS
/// `port`, `funneled` through Funnel `ports` and so public, `missing`, or `unknown` with a
/// `reason`. Outside `routed`, `port` is the one the setup command would use.
public struct ServeRoute: Decodable, Equatable, Sendable {
  public var state: String
  public var port: Int
  public var ports: [Int]?
  public var reason: String?

  public func endpoint(dnsName: String) -> String {
    port == 443 ? "wss://\(dnsName)" : "wss://\(dnsName):\(port)"
  }

  public func setupCommand(serverPort: Int) -> String {
    "tailscale serve --bg --https=\(port) http://127.0.0.1:\(serverPort)"
  }
}

/// `GET /health` on the server's loopback port.
public struct ServerHealth: Decodable, Equatable, Sendable {
  public var server: String
  public var name: String
  public var version: String
  public var stim: String
  public var protocolVersion: Int
  /// The `STIM_HOME` the server keeps its pairing state and Unix socket under.
  public var stimHome: String
  public var tailscale: TailscaleState
  /// The `tailscale serve` route read on this request, present while Tailscale runs.
  public var route: ServeRoute?
  public var nativeViewerOpened: Bool?
  /// True when the server serves this Mac only, so phones and other Macs cannot connect through it.
  public var loopbackOnly: Bool?

  enum CodingKeys: String, CodingKey {
    case server, name, version, stim, stimHome, tailscale, route, nativeViewerOpened, loopbackOnly
    case protocolVersion = "protocol"
  }

  /// What Desktop knows of the home's stimd before its network listener answers `/health`.
  public init(record: StimdRecord, stimHome: String) {
    server = "stimd"
    name = Host.current().localizedName ?? ""
    version = record.version
    stim = record.version
    protocolVersion = 2
    self.stimHome = stimHome
    tailscale = TailscaleState(state: "unavailable", reason: "the network listener is not running")
    loopbackOnly = true
  }

  /// Whether `stimHome` is `~/.stim`, compared after resolving symlinks.
  public func servesDefaultHome(home: String = NSHomeDirectory()) -> Bool {
    StimHome.isDefault(stimHome, home: home)
  }
}

/// A stim-server that answers health requests but is not ready to serve its Stim home.
public enum ServerStartup: Equatable, Sendable {
  case pending
  case degraded(String)
}

/// A loopback health answer, including HTTP 503 while stim-server reads its Stim home.
public enum ServerHealthProbe: Equatable, Sendable {
  case ready(ServerHealth)
  case notReady(ServerStartup, stimHome: String?)
}

/// `stim pair --json`: the QR payload and when its single-use token expires.
public struct PairingCode: Decodable, Equatable, Sendable {
  public struct QR: Codable, Equatable, Sendable {
    public var v: Int
    public var name: String
    public var endpoint: String
    public var pairingToken: String
    /// The base64url SHA-256 of the server's X25519 public key, which the phone pins.
    public var fingerprint: String
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

/// A device in `stim pairings --json`.
public struct PairedDevice: Decodable, Equatable, Identifiable, Sendable {
  public var id: String
  public var name: String
  /// Where it paired or was approved from, as the server described the peer, such as its tailnet node.
  public var from: String?
  /// The base64url SHA-256 of the client's public key.
  public var keyFingerprint: String
  public var pairedAt: Date
  public var lastSeenAt: Date?
  public var capabilities: [String]
  /// `phone` for a pairing from `stim pair`, `desktop` for Stim Desktop on another machine, `build-client`,
  /// `device-host-client` or `test-client`; absent from an older stim-server.
  public var kind: String?

  /// Whether the device may run actions and drive devices, not only read.
  public var canControl: Bool { capabilities.contains("control") }

  /// A machine that may build here, rather than a phone or app that reads.
  public var isBuildClient: Bool { capabilities.contains("build") }

  /// A machine that may run hosted devices here.
  public var isDeviceHostClient: Bool { capabilities.contains("device-host") }

  /// A machine that may run any command it sends here, approved by `stim setup --test`.
  public var isTestClient: Bool { capabilities.contains("test") }

  /// A pairing from `stim pair` that reads and may control: a phone, or Stim Desktop on another machine.
  public var isPhone: Bool { !isBuildClient && !isDeviceHostClient && !isTestClient }
}

struct PairedDeviceList: Decodable {
  var devices: [PairedDevice]
}

/// Runs this Mac's Stim engine for the pairing commands Desktop has no request for.
public struct StimServerCLI: Sendable {
  public let environment: [String: String]
  public let engine: EngineLaunch?

  public init(environment: [String: String], engine: EngineLaunch?) {
    self.environment = environment
    self.engine = engine
  }

  private func command(_ arguments: [String]) throws -> (program: String, arguments: [String]) {
    guard let engine else { throw Failure.notFound }
    return engine.stim(arguments)
  }

  public enum Failure: LocalizedError {
    case notFound
    case exited(Int32, String)

    public var errorDescription: String? {
      switch self {
      case .notFound:
        return "No Stim engine is installed on this Mac. Stim Desktop installs one when it starts; try again."
      case .exited(let code, let stderr):
        return stderr.isEmpty ? "stim exited with status \(code)." : stderr
      }
    }
  }

  static let decoder: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let text = try decoder.singleValueContainer().decode(String.self)
      if let date = parseTimestamp(text) { return date }
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a date: \(text)"))
    }
    return decoder
  }()

  /// What the engine's `stim --version` printed, or nil when it is missing, fails to start, or exits non-zero.
  public func versionOutput() async -> String? {
    (try? await run(["--version"])).map { String(decoding: $0, as: UTF8.self) }
  }

  public func pair(port: Int, control: Bool) async throws -> PairingCode {
    try decodeReporting(
      PairingCode.self, from: await run(["pair", "--json", "--port", String(port)] + (control ? ["--control"] : [])),
      source: .cli, decoder: Self.decoder)
  }

  public func devices() async throws -> [PairedDevice] {
    try decodeReporting(PairedDeviceList.self, from: await run(["pairings", "--json"]), source: .cli, decoder: Self.decoder)
      .devices
  }

  public func grant(_ id: String, control: Bool) async throws {
    _ = try await run(["pairings", "grant", id, control ? "--control" : "--read"])
  }

  public func revoke(_ id: String) async throws {
    _ = try await run(["pairings", "revoke", id])
  }

  public func rename(_ id: String, to name: String) async throws {
    _ = try await run(["pairings", "rename", id, name])
  }

  /// The server answering on `port` of this Mac, or nil when none does.
  public static func health(port: Int) async -> ServerHealthProbe? {
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/health")!)
    request.timeoutInterval = 2
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      let response = response as? HTTPURLResponse
    else { return nil }
    return decodeHealth(data, statusCode: response.statusCode)
  }

  static func decodeHealth(_ data: Data, statusCode: Int) -> ServerHealthProbe? {
    if statusCode == 200 {
      guard let health = try? decoder.decode(ServerHealth.self, from: data), health.server == "stim-server" else {
        return nil
      }
      return .ready(health)
    }
    struct Answer: Decodable {
      struct Startup: Decodable {
        var state: String
        var reason: String?
      }
      var server: String
      var stimHome: String?
      var startup: Startup
    }
    guard statusCode == 503,
      let answer = try? decoder.decode(Answer.self, from: data), answer.server == "stim-server"
    else { return nil }
    let startup: ServerStartup
    switch answer.startup.state {
    case "pending": startup = .pending
    case "degraded": startup = .degraded(answer.startup.reason ?? "The server could not read its Stim home.")
    default: startup = .degraded("Unknown server startup state: \(answer.startup.state).")
    }
    return .notReady(startup, stimHome: answer.stimHome)
  }

  private func run(_ args: [String]) async throws -> Data {
    let command = try command(args)
    let log = DebugLog.CLIRun(tool: "stim", arguments: args, cwd: nil)
    var environment = environment
    environment["STIM_RUN_ID"] = log.runID
    var request = ProcessRequest(command.program, command.arguments, environment: environment)
    request.captureStderr = true
    let result: ProcessResult
    do {
      result = try await request.run()
    } catch {
      log.fail(error)
      throw error
    }
    log.finish(status: result.status, timedOut: result.timedOut, stderr: stderrTail(result.stderrText))
    guard result.status == 0 else {
      throw Failure.exited(result.status, result.stderrText.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    return result.stdout
  }
}
