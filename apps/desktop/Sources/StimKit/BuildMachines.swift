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

    var readinessTone: MachineReadiness.Tone {
      switch self {
      case .approved: return .success
      case .pending, .notOnTailnet, .tailscaleOff, .unreachable: return .warning
      case .revoked, .nodeChanged, .invalid: return .error
      case .notAsked, .unknown: return .neutral
      }
    }

    /// Whether asking again through `stim doctor --fix` can change it, given whether this Mac already has a request.
    public func canAsk(requested: Bool) -> Bool {
      self == .notAsked || self == .revoked || (self == .unreachable && !requested)
    }
  }

  /// One reason `stim doctor` gave for a machine not taking builds, with its finding code.
  public struct Problem: Decodable, Hashable, Sendable {
    public var code: String
    public var reason: String
  }

  public struct Capacity: Decodable, Hashable, Sendable {
    public var loadPerCore: Double?
  }

  public var machine: String
  public var state: State
  public var dnsName: String?
  public var deviceId: String?
  public var requestedAt: String?
  /// For an approved machine: whether it would take builds now, and each reason it would not.
  public var offloadable: Bool?
  public var reasons: [String]?
  public var problems: [Problem]?
  public var capacity: Capacity?

  public var id: String { machine }

  public init(machine: String, state: State, dnsName: String? = nil, deviceId: String? = nil) {
    self.machine = machine
    self.state = state
    self.dnsName = dnsName
    self.deviceId = deviceId
  }

  /// Whether it takes builds now: "Ready", or the first reason `stim doctor` gave with its remedy, such as
  /// "Stim build differs" and "update the build machine", or "Busy (load 8.2/core)"; its pairing state when it is not
  /// approved. `reasons` lists every reason, one per line. `detail` says the same remedy as a sentence.
  public var readiness: MachineReadiness {
    let all = reasons.flatMap { $0.isEmpty ? nil : $0.joined(separator: "\n") }
    guard state == .approved, let offloadable else {
      return MachineReadiness(title: state.title, remedy: nil, tone: state.readinessTone, reasons: all)
    }
    if offloadable { return MachineReadiness(title: "Ready", remedy: nil, tone: .success, reasons: nil) }
    let first = problems?.first
    if first?.code == "busy" {
      let load = capacity?.loadPerCore.map { " (load \(formatLoad($0))/core)" } ?? ""
      return MachineReadiness(title: "Busy\(load)", remedy: nil, tone: .warning, reasons: all)
    }
    if let first, let known = MachineReadiness.problems[first.code] {
      return MachineReadiness(
        title: known.0, remedy: known.1, tone: first.code == "unreachable" ? .warning : .error, reasons: all)
    }
    return MachineReadiness(title: reasons?.first ?? "Cannot take builds", remedy: nil, tone: .error, reasons: all)
  }

  public var detail: String {
    switch state {
    case .approved:
      if offloadable != false { return "Builds can run on this Mac." }
      return readiness.remedy.map { $0.prefix(1).uppercased() + $0.dropFirst() + "." } ?? "Builds stay on this Mac for now."
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

/// A build machine's readiness for builds, as `BuildMachineStatus.readiness` reads it from `stim doctor`.
public struct MachineReadiness: Equatable, Sendable {
  public enum Tone: Sendable { case success, warning, error, neutral }

  public var title: String
  public var remedy: String?
  public var tone: Tone
  public var reasons: String?

  /// `Stim build differs \u{2014} update the build machine`, or the title alone.
  public var line: String { remedy.map { "\(title) \u{2014} \($0)" } ?? title }

  /// The short title and remedy of each `stim doctor` build-machine reason code; `busy` is built from the load.
  static let problems: [String: (String, String)] = {
    let sdk = "install it with sdkmanager there"
    return [
      "unreachable": ("Not answering", "check its stim-server"),
      "checkout": ("Not a git checkout", "run Stim from a git checkout"),
      "stim-build": ("Stim build differs", "update the build machine"),
      "arch": ("Other CPU", "use a Mac with the same CPU"),
      "xcode": ("Xcode differs", "select the same Xcode on both"),
      "simulator-sdk": ("Simulator SDK differs", "select the same Xcode on both"),
      "cocoapods": ("CocoaPods differs", "install the same CocoaPods there"),
      "runtime": ("No simulator runtime", "install the iOS runtime there"),
      "jdk": ("JDK differs", "use the same JDK there"),
      "android-sdk": ("No Android SDK", "install one there"),
      "ndk": ("NDK missing", sdk),
      "build-tools": ("Build-tools missing", sdk),
      "compile-sdk": ("Android platform missing", sdk),
      "disk": ("Low on disk", "free space there"),
    ]
  }()
}

private func formatLoad(_ value: Double) -> String {
  value == value.rounded() ? String(Int(value)) : String(value)
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
