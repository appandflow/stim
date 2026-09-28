import Foundation

/// Another Mac on the tailnet, from `tailscale status --json`.
public struct TailnetMac: Hashable, Identifiable, Sendable {
  /// The node's StableID.
  public var id: String
  public var hostName: String
  /// The MagicDNS name, lowercased, without the trailing dot.
  public var dnsName: String

  /// The `offload.machines` entry that names it: the first label of its MagicDNS name.
  public var machine: String { String(dnsName.split(separator: ".").first ?? Substring(dnsName)) }
}

public enum Tailnet {
  static let appBinary = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  /// The HTTPS port `stim-server` suggests for its `tailscale serve` route, and `offload.machines`' default.
  public static let servePort = 7443

  /// The other macOS peers that are online, by name; nil when Tailscale is not running.
  public static func macs(statusJSON: Data) -> [TailnetMac]? {
    guard let status = try? JSONSerialization.jsonObject(with: statusJSON) as? [String: Any],
      status["BackendState"] as? String == "Running"
    else { return nil }
    let peers = (status["Peer"] as? [String: Any] ?? [:]).values.compactMap { $0 as? [String: Any] }
    return peers.compactMap { peer -> TailnetMac? in
      guard peer["OS"] as? String == "macOS", peer["Online"] as? Bool == true,
        let id = peer["ID"] as? String, let dns = peer["DNSName"] as? String
      else { return nil }
      let dnsName = (dns.hasSuffix(".") ? String(dns.dropLast()) : dns).lowercased()
      guard !dnsName.isEmpty else { return nil }
      return TailnetMac(id: id, hostName: peer["HostName"] as? String ?? dnsName, dnsName: dnsName)
    }
    .sorted { $0.dnsName < $1.dnsName }
  }

  /// `tailscale status --json`, from the CLI on `PATH` or the Mac app's; nil when neither answers.
  public static func status(environment: [String: String]) -> Data? {
    var environment = environment
    let candidates = [resolveExecutable("tailscale", override: nil, environment: &environment), appBinary]
    for binary in candidates.compactMap({ $0 }) where FileManager.default.isExecutableFile(atPath: binary) {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: binary)
      process.arguments = ["status", "--json"]
      process.environment = environment
      let out = Pipe()
      process.standardOutput = out
      process.standardError = FileHandle.nullDevice
      guard (try? process.run()) != nil else { continue }
      let data = out.fileHandleForReading.readDataToEndOfFile()
      process.waitUntilExit()
      if process.terminationStatus == 0 { return data }
    }
    return nil
  }

  /// Whether `stim-server` answers `GET /health` on the Mac's `tailscale serve` route at `port`.
  public static func servesStim(dnsName: String, port: Int = servePort) async -> Bool {
    guard let url = URL(string: "https://\(dnsName):\(port)/health") else { return false }
    var request = URLRequest(url: url)
    request.timeoutInterval = 3
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      (response as? HTTPURLResponse)?.statusCode == 200,
      let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return false }
    return body["server"] as? String == "stim-server"
  }
}

/// Where this Mac stands with one `offload.machines` entry, as `stim doctor --json` reports it.
public struct BuildMachineStatus: Decodable, Hashable, Identifiable, Sendable {
  public enum State: String, Decodable, Sendable {
    case approved, pending, revoked, invalid, unreachable, unknown
    case notAsked = "not-asked"
    case nodeChanged = "node-changed"
    case notOnTailnet = "not-on-tailnet"
    case tailscaleOff = "tailscale-off"

    public init(from decoder: Decoder) throws {
      self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }

    public var title: String {
      switch self {
      case .approved: return "Approved"
      case .pending: return "Waiting for approval"
      case .notAsked: return "Not asked"
      case .revoked: return "Revoked"
      case .nodeChanged: return "Different Mac"
      case .notOnTailnet: return "Not on the tailnet"
      case .tailscaleOff: return "Tailscale is off"
      case .unreachable: return "Unreachable"
      case .invalid: return "Not a tailnet name"
      case .unknown: return "Unknown"
      }
    }

    /// Whether asking again through `stim doctor --fix` can change it.
    public var canAsk: Bool { self == .notAsked || self == .revoked }
  }

  public var machine: String
  public var state: State
  public var dnsName: String?
  public var deviceId: String?
  public var requestedAt: String?

  public var id: String { machine }

  public init(machine: String, state: State, dnsName: String? = nil, deviceId: String? = nil) {
    self.machine = machine
    self.state = state
    self.dnsName = dnsName
    self.deviceId = deviceId
  }

  public var detail: String {
    switch state {
    case .approved: return "Builds can run on this Mac."
    case .pending:
      let grant = deviceId.map { " or runs stim-server devices grant \($0) --build there" } ?? ""
      return "Someone on \(machine) allows it in Stim Desktop\(grant). The request lapses after 15 minutes."
    case .notAsked: return "This Mac has not asked it yet."
    case .revoked: return "It revoked this Mac, denied the request, or the request lapsed."
    case .nodeChanged:
      return
        "The name now belongs to a different tailnet node than the one this Mac asked, so Stim does not connect to it. If that Mac was replaced, remove it here, which forgets the old node, then use it for builds again."
    case .notOnTailnet: return "No Mac on this tailnet has that name."
    case .tailscaleOff: return "Start Tailscale to reach it."
    case .unreachable: return "stim-server did not answer on its tailscale serve route."
    case .invalid: return "Expected a MagicDNS name, optionally with :port."
    case .unknown: return "Update Stim Desktop to show this state."
    }
  }
}

/// `offload.machines` edits, as the JSON text `stim settings set` takes.
public enum OffloadMachines {
  /// The name part of an entry, without its port.
  public static func name(_ entry: String) -> String {
    String(entry.split(separator: ":").first ?? Substring(entry)).lowercased()
  }

  /// Whether an entry names `mac`: its first label or its full MagicDNS name.
  public static func names(_ entry: String, _ mac: TailnetMac) -> Bool {
    let name = name(entry)
    return name == mac.machine || name == mac.dnsName
  }

  /// The list with `entry` added, as JSON text.
  public static func adding(_ entry: String, to entries: [String]) -> String {
    encode(entries.contains(entry) ? entries : entries + [entry])
  }

  /// The list without `entry` as JSON text, or nil when it is empty and the setting should be unset.
  public static func removing(_ entry: String, from entries: [String]) -> String? {
    let rest = entries.filter { $0 != entry }
    return rest.isEmpty ? nil : encode(rest)
  }

  private static func encode(_ entries: [String]) -> String {
    String(decoding: (try? JSONEncoder().encode(entries)) ?? Data("[]".utf8), as: UTF8.self)
  }
}
