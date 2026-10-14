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

/// `stim-server pair --json`: the QR payload and when its single-use token expires.
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

/// A device in `stim-server devices --json`.
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

  /// Whether the device may run actions and drive devices, not only read.
  public var canControl: Bool { capabilities.contains("control") }

  /// A Mac that may build here, rather than a phone or app that reads.
  public var isBuildClient: Bool { capabilities.contains("build") }

  /// A Mac that may run hosted devices here.
  public var isDeviceHostClient: Bool { capabilities.contains("device-host") }

  /// A paired phone or app that reads and may control, as the Phones list shows it.
  public var isPhone: Bool { !isBuildClient && !isDeviceHostClient }
}

struct PairedDeviceList: Decodable {
  var devices: [PairedDevice]
}

/// The Node runtime and stim-server that Stim.app carries in `Contents/Resources/stim-server`.
public struct BundledServer: Equatable, Sendable {
  public let node: String
  public let script: String

  public init(node: String, script: String) {
    self.node = node
    self.script = script
  }

  /// The directory holding `bin/node` and `node_modules`.
  public var root: String {
    ((node as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent
  }

  /// The runtime inside `bundle`, or nil in a build that does not carry one, such as `swift run` or `stim macos`.
  public static func inApp(_ bundle: Bundle = .main) -> BundledServer? {
    guard let root = bundle.resourceURL?.appendingPathComponent("stim-server") else { return nil }
    let server = BundledServer(
      node: root.appendingPathComponent("bin/node").path,
      script: root.appendingPathComponent("node_modules/@stim-cli/server/dist/stim-server.mjs").path)
    guard FileManager.default.isExecutableFile(atPath: server.node), FileManager.default.fileExists(atPath: server.script)
    else { return nil }
    return server
  }
}

/// Runs `stim-server`, which serves Stim state to paired phones over Tailscale.
public struct StimServerCLI: Sendable {
  public static let defaultPort = 7787

  /// The override, the bundled server's script, or the first `stim-server` on the environment's `PATH`.
  public let executable: String?
  public let environment: [String: String]
  /// Runs `executable`'s script under the home directory's Node; nil runs `executable` through its own shebang.
  public let launcher: NodeLauncher?
  /// The server Stim.app carries, which runs unless an override is set.
  public let bundled: BundledServer?

  public init(
    environment: [String: String], override: String? = nil, launcher: NodeLauncher? = nil,
    bundled: BundledServer? = BundledServer.inApp()
  ) {
    var environment = environment
    if override?.isEmpty ?? true, let bundled {
      self.executable = bundled.script
      self.bundled = bundled
      self.launcher = nil
    } else {
      self.executable = resolveExecutable("stim-server", override: override, environment: &environment)
      self.bundled = nil
      self.launcher = launcher
    }
    self.environment = environment
  }

  /// `init(environment:override:)` with a launcher, so a project's Node pin does not choose the Node it runs on.
  /// `layout` names the package managers' global directories, which only a version-manager shim needs.
  public static func resolve(
    environment: [String: String], override: String? = nil,
    layout: (() async -> PackageManagerLayout)? = nil
  ) async -> StimServerCLI {
    let cli = StimServerCLI(environment: environment, override: override)
    guard cli.bundled == nil else { return cli }
    let launcher = await NodeLauncher.resolve(
      executable: cli.executable, name: "stim-server", environment: cli.environment, layout: layout)
    return StimServerCLI(environment: environment, override: override, launcher: launcher)
  }

  private func command(_ arguments: [String]) throws -> (program: String, arguments: [String]) {
    if let bundled { return (bundled.node, [bundled.script] + arguments) }
    guard let executable else { throw Failure.notFound }
    return try launcher?.command(arguments) ?? (executable, arguments)
  }

  public enum Failure: LocalizedError {
    case notFound
    case exited(Int32, String)

    public var errorDescription: String? {
      switch self {
      case .notFound:
        return
          "This build of Stim Desktop does not include stim-server. Choose one in Settings, or install @stim-cli/server globally."
      case .exited(let code, let stderr):
        return stderr.isEmpty ? "stim-server exited with status \(code)." : stderr
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

  public static let minimumVersion = SemanticVersion("1.21.0")!

  /// What `stim-server --version` printed, or nil when it is missing, fails to start, or exits non-zero.
  public func versionOutput() async -> String? {
    (try? await run(["--version"])).map { String(decoding: $0, as: UTF8.self) }
  }

  public func pair(port: Int = defaultPort, control: Bool) async throws -> PairingCode {
    try decodeReporting(
      PairingCode.self, from: await run(["pair", "--json", "--port", String(port)] + (control ? ["--control"] : [])),
      source: .cli, decoder: Self.decoder)
  }

  public func devices() async throws -> [PairedDevice] {
    try decodeReporting(PairedDeviceList.self, from: await run(["devices", "--json"]), source: .cli, decoder: Self.decoder)
      .devices
  }

  public func grant(_ id: String, control: Bool) async throws {
    _ = try await run(["devices", "grant", id, control ? "--control" : "--read"])
  }

  public func revoke(_ id: String) async throws {
    _ = try await run(["devices", "revoke", id])
  }

  /// Starts the server on `port`; it runs until terminated.
  public func serve(
    port: Int = defaultPort,
    loopbackOnly: Bool = false,
    bootstrap: DesktopBootstrapKey? = nil,
    onLine: @escaping @Sendable (OutputLine) -> Void,
    onExit: @escaping @Sendable (Int32) -> Void
  ) throws -> Process {
    let arguments = ["--port", String(port)] + (loopbackOnly ? ["--loopback-only"] : [])
    let command = try command(arguments)
    let run = DebugLog.CLIRun(tool: "stim-server", arguments: arguments, cwd: NSHomeDirectory())
    var environment = environment
    environment.removeValue(forKey: "STIM_DESKTOP_BOOTSTRAP_FD")
    let input: Pipe?
    if let bootstrap {
      guard bundled != nil else {
        throw ServerError(code: "forbidden", message: "Private Desktop bootstrap requires the bundled server.")
      }
      let pipe = Pipe()
      try pipe.fileHandleForWriting.write(contentsOf: bootstrap.input)
      input = pipe
      environment["STIM_DESKTOP_BOOTSTRAP_FD"] = "0"
    } else {
      input = nil
    }
    defer { try? input?.fileHandleForReading.close() }
    environment["STIM_RUN_ID"] = run.runID
    if bundled != nil, let cache = Self.compileCache { environment["NODE_COMPILE_CACHE"] = cache }
    let tail = LockedValue([String]())
    let lifetime = input?.fileHandleForWriting
    do {
      return try ProcessStream.start(
        executable: command.program, arguments: command.arguments, cwd: NSHomeDirectory(),
        environment: environment,
        standardInput: input?.fileHandleForReading,
        onLine: { line in
          if line.channel == .stderr { tail.withLock { $0 = Array(($0 + [line.text]).suffix(3)) } }
          onLine(line)
        },
        onExit: { status in
          try? lifetime?.close()
          DebugLog.info(
            .server,
            "stim-server process exited status=\(status) run=\(run.runID) stderr: \(tail.withLock { $0.joined(separator: " | ") })"
          )
          onExit(status)
        })
    } catch {
      try? lifetime?.close()
      throw error
    }
  }

  /// Where the bundled Node keeps V8's compile cache, which it keys by Node version and script contents.
  static var compileCache: String? {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
      .appendingPathComponent(Bundle.main.bundleIdentifier ?? "dev.stim.desktop")
      .appendingPathComponent("node-compile-cache").path
  }

  /// The server answering on `port` of this Mac, or nil when none does.
  public static func health(port: Int = defaultPort) async -> ServerHealthProbe? {
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
    let log = DebugLog.CLIRun(tool: "stim-server", arguments: args, cwd: nil)
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
