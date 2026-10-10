import Foundation

/// Another Mac on the tailnet, from `tailscale status --json`.
public struct TailnetMac: Hashable, Identifiable, Sendable {
  /// The node's StableID.
  public var id: String
  public var hostName: String
  /// The MagicDNS name, lowercased, without the trailing dot.
  public var dnsName: String

  /// The `remote.machines` entry that names it: the first label of its MagicDNS name.
  public var machine: String { String(dnsName.split(separator: ".").first ?? Substring(dnsName)) }
}

public enum Tailnet {
  static let appBinary = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  /// The HTTPS port `stim-server` suggests for its `tailscale serve` route, and `remote.machines`' default.
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
      if let result = try? ProcessRequest(binary, ["status", "--json"], environment: environment).runBlocking(),
        result.status == 0
      {
        return result.stdout
      }
    }
    return nil
  }

  public struct Peer: Hashable, Identifiable, Sendable {
    public var mac: TailnetMac
    public var online: Bool
    public var id: String { mac.id }
  }

  /// How Tailscale is installed on this Mac: the Mac app (turned on from its menu bar item), only the CLI
  /// (`tailscale up`), or not at all.
  public enum Install: Equatable, Sendable {
    case app, cli, none

    public static func detect(
      environment: [String: String], exists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> Install {
      if exists(appBinary) { return .app }
      let path = (environment["PATH"] ?? "").split(separator: ":")
      return path.contains { exists("\($0)/tailscale") } ? .cli : .none
    }
  }

  public enum Reachability: Equatable, Sendable {
    case tailscaleMissing, tailscaleStopped, peerOffline, ready
  }

  public struct Health: Decodable, Equatable, Sendable {
    public var server: String
    public var version: String
    public var `protocol`: Int
  }

  public static func selfNode(statusJSON: Data) -> TailnetMac? {
    guard let status = try? JSONSerialization.jsonObject(with: statusJSON) as? [String: Any],
      let node = status["Self"] as? [String: Any]
    else { return nil }
    return parseNode(node)
  }

  public static func peers(statusJSON: Data) -> [Peer] {
    guard let status = try? JSONSerialization.jsonObject(with: statusJSON) as? [String: Any] else { return [] }
    return (status["Peer"] as? [String: Any] ?? [:]).values.compactMap { value in
      guard let node = value as? [String: Any], node["OS"] as? String == "macOS", let mac = parseNode(node)
      else { return nil }
      return Peer(mac: mac, online: node["Online"] as? Bool == true)
    }.sorted { $0.mac.dnsName < $1.mac.dnsName }
  }

  /// `install` tells a quit Tailscale app, whose CLI answers nothing, from a missing Tailscale.
  public static func reachability(statusJSON: Data?, peer: Peer?, install: Install = .none) -> Reachability {
    guard let statusJSON else { return install == .none ? .tailscaleMissing : .tailscaleStopped }
    guard let status = try? JSONSerialization.jsonObject(with: statusJSON) as? [String: Any],
      status["BackendState"] as? String == "Running"
    else { return .tailscaleStopped }
    return peer?.online == true ? .ready : .peerOffline
  }

  private static func parseNode(_ node: [String: Any]) -> TailnetMac? {
    guard let id = node["ID"] as? String, !id.isEmpty,
      let dns = node["DNSName"] as? String, !dns.isEmpty
    else { return nil }
    let name = dns.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased()
    return TailnetMac(id: id, hostName: node["HostName"] as? String ?? name, dnsName: name)
  }

  public static func health(dnsName: String, port: Int = servePort) async -> Health? {
    guard let url = URL(string: "https://\(dnsName):\(port)/health") else { return nil }
    var request = URLRequest(url: url)
    request.timeoutInterval = 3
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      (response as? HTTPURLResponse)?.statusCode == 200,
      let health = try? JSONDecoder().decode(Health.self, from: data), health.server == "stim-server"
    else { return nil }
    return health
  }
}

/// Where this Mac stands with one `remote.machines` entry, as `stim doctor --json` reports it.
public struct BuildMachineStatus: Decodable, Hashable, Identifiable, Sendable {
  public enum State: String, Decodable, Sendable {
    case approved, pending, revoked, lapsed, invalid, unreachable, unknown
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
      case .lapsed: return "Request lapsed"
      case .nodeChanged: return "Different Mac"
      case .notOnTailnet: return "Not on the tailnet"
      case .tailscaleOff: return "Tailscale is off"
      case .unreachable: return "Unreachable"
      case .invalid: return "Not a tailnet name"
      case .unknown: return "Unknown"
      }
    }

    var readinessTone: Tone {
      switch self {
      case .approved: return .success
      case .pending, .notOnTailnet, .tailscaleOff, .unreachable: return .warning
      case .revoked, .lapsed, .nodeChanged, .invalid: return .error
      case .notAsked, .unknown: return .neutral
      }
    }

    /// Whether asking again through `stim doctor --fix` can change it, given whether this Mac already has a request.
    public func canAsk(requested: Bool) -> Bool {
      self == .notAsked || self == .revoked || self == .lapsed || (self == .unreachable && !requested)
    }
  }

  /// One reason `stim doctor` gave for a machine not taking builds, with its finding code.
  public struct Problem: Decodable, Hashable, Sendable {
    public var code: String
    public var reason: String
  }

  public struct Capacity: Decodable, Hashable, Sendable {
    public var loadPerCore: Double?
    public var cpus: Int?
    /// Offloaded builds it runs now, and how many it takes at once.
    public var running: Int?
    public var max: Int?
    /// Native builds it runs now, its own and offloaded, and how many it takes at once (0 when unlimited).
    public var builds: Int?
    public var maxBuilds: Int?
    public var diskFreeBytes: Double?
    public var maxLoadPerCore: Double?
    /// Memory in use, as Activity Monitor counts it, and the Mac's total. Absent from an older stim-server.
    public var memoryUsedBytes: Double?
    public var memoryTotalBytes: Double?

    /// What the Busy pill adds: the load when it is at its limit, else the builds it runs, else the load.
    var busyDetail: String? {
      let load = loadPerCore.map { "load \(formatLoad($0))/core" }
      let atLimit = loadPerCore.map { load in maxLoadPerCore.map { load >= $0 } ?? false } ?? false
      return (atLimit ? load : buildsText ?? load).map { " (\($0))" }
    }

    /// The builds it runs, such as "1/2 builds" or "3 builds"; nil when it reported no count.
    public var buildsText: String? {
      guard let builds else { return nil }
      if let maxBuilds, maxBuilds > 0 { return "\(builds)/\(maxBuilds) builds" }
      return "\(builds) \(builds == 1 ? "build" : "builds")"
    }

    /// A byte count from a remote Mac's JSON number; nil when it is not a whole number that fits.
    private static func wholeBytes(_ value: Double) -> Int64? { Int64(exactly: value.rounded()) }

    /// The load, memory and free disk it reported, with the icon and format the toolbar's resource summary uses.
    /// The CPU entry is the 5-minute load per core, since the offer carries no CPU percentage.
    public var resources: [MachineResource] {
      var items: [MachineResource] = []
      if let loadPerCore {
        let fraction = maxLoadPerCore.map { loadPerCore / $0 }
        items.append(
          MachineResource(
            kind: .cpu, label: "Load", value: "\(formatLoad(loadPerCore))/core",
            tone: fraction.map(UsageThresholds.cpu(fraction:)) ?? .normal))
      }
      if let used = memoryUsedBytes.flatMap(Self.wholeBytes), let total = memoryTotalBytes.flatMap(Self.wholeBytes) {
        items.append(
          MachineResource(
            kind: .memory, label: "RAM", value: Format.memoryPair(usedBytes: used, totalBytes: total), tone: .normal))
      }
      if let free = diskFreeBytes.flatMap(Self.wholeBytes) {
        items.append(
          MachineResource(
            kind: .disk, label: "Disk", value: "\(Format.fileSize(free)) free", tone: UsageThresholds.disk(freeBytes: free)))
      }
      return items
    }

    /// The load, cores, offloaded builds and free disk it reported, separated by middle dots.
    public var line: String {
      var parts: [String] = []
      if let loadPerCore {
        parts.append("load \(formatLoad(loadPerCore))/core" + (maxLoadPerCore.map { " of \(formatLoad($0))" } ?? ""))
      }
      if let cpus { parts.append("\(cpus) cores") }
      if let running, let max { parts.append("\(running) of \(max) offloaded builds") }
      if let diskFreeBytes { parts.append("\(Format.freeSpace(diskFreeBytes)) free") }
      return parts.joined(separator: " \u{00B7} ")
    }
  }

  public struct Host: Decodable, Hashable, Sendable {
    public var name: String
    public var screenRecording: Bool
    public var accessibility: Bool

    public init(name: String, screenRecording: Bool, accessibility: Bool) {
      self.name = name
      self.screenRecording = screenRecording
      self.accessibility = accessibility
    }
  }

  public var host: Host?
  public var machine: String
  public var state: State
  public var dnsName: String?
  public var deviceId: String?
  public var requestedAt: String?
  public var expiresAt: String?
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
  /// "Stim build differs" and "update the remote Mac", or "Busy (load 8.2/core)"; its pairing state when it is not
  /// approved. `reasons` lists every reason, one per line. `detail` says the same remedy as a sentence.
  public var readiness: MachineReadiness {
    let all = reasons.flatMap { $0.isEmpty ? nil : $0.joined(separator: "\n") }
    guard state == .approved, let offloadable else {
      return MachineReadiness(title: state.title, remedy: nil, tone: state.readinessTone, reasons: all)
    }
    if offloadable { return MachineReadiness(title: "Ready", remedy: nil, tone: .success, reasons: nil) }
    let first = problems?.first
    if first?.code == "busy" {
      return MachineReadiness(title: "Busy\(capacity?.busyDetail ?? "")", remedy: nil, tone: .warning, reasons: all)
    }
    if let first, let known = MachineReadiness.problems[first.code] {
      return MachineReadiness(
        title: known.0, remedy: known.1, tone: first.code == "unreachable" ? .warning : .error, reasons: all)
    }
    return MachineReadiness(title: reasons?.first ?? "Cannot take builds", remedy: nil, tone: .error, reasons: all)
  }

  /// The one pill a row of the remote Mac list shows: Approved, Waiting for approval, Unreachable, Needs update or
  /// the first problem's short title for the states that matter most, else the readiness title (Busy, Revoked, ...).
  public var listStatus: MachineListStatus {
    let ready = readiness
    switch state {
    case .approved:
      guard offloadable == false else { return MachineListStatus(title: "Approved", tone: .success) }
      let code = problems?.first?.code
      if code == "unreachable" { return MachineListStatus(title: "Unreachable", tone: .warning) }
      if code == "busy" { return MachineListStatus(title: ready.title, tone: ready.tone) }
      if code == "stim-build" { return MachineListStatus(title: "Needs update", tone: .warning) }
      return MachineListStatus(title: code.flatMap { MachineReadiness.problems[$0]?.0 } ?? "Not offloading", tone: .warning)
    case .pending: return MachineListStatus(title: "Waiting for approval", tone: .warning)
    default: return MachineListStatus(title: state.title, tone: state.readinessTone)
    }
  }

  /// A reason an approved machine takes no builds now, with what fixes it when that is known.
  public struct ProblemLine: Equatable, Sendable {
    public enum Fix: Equatable, Sendable {
      /// A command to run on the remote Mac.
      case command(String)
      case advice(String)
    }

    public var code = ""
    public var reason: String
    public var fix: Fix?
  }

  /// Each reason of an approved machine that is not offloadable, in doctor's order, except Busy, which the pill
  /// covers; empty otherwise.
  public var problemLines: [ProblemLine] {
    guard state == .approved, offloadable == false else { return [] }
    return (problems ?? []).filter { $0.code != "busy" }.map { problem in
      if problem.code == "cocoapods", let command = Self.cocoapodsFix(problem.reason) {
        return ProblemLine(code: problem.code, reason: problem.reason, fix: .command(command))
      }
      let reason = problem.code == "stim-build" ? Self.shortStimBuild(problem.reason) : problem.reason
      let advice = MachineReadiness.problems[problem.code]?.1
      return ProblemLine(
        code: problem.code, reason: reason, fix: advice.map { .advice($0.prefix(1).uppercased() + $0.dropFirst() + ".") })
    }
  }

  /// "Stim build 5773060 there, d9b8bdb here" from doctor's full 16-digit build digests.
  static func shortStimBuild(_ reason: String) -> String {
    guard let match = reason.wholeMatch(of: /Stim build (\S+) there, (\S+) here/) else { return reason }
    return "Stim build \(match.1.prefix(7)) there, \(match.2.prefix(7)) here"
  }

  /// The command that gives the remote Mac this Mac's CocoaPods, from "CocoaPods 1.17.0 there, 1.16.2 here".
  static func cocoapodsFix(_ reason: String) -> String? {
    let words = reason.split(separator: " ").map(String.init)
    guard words.count == 5, words[0] == "CocoaPods", words[2] == "there,", words[4] == "here" else { return nil }
    let here = words[3]
    guard !here.isEmpty, here.allSatisfy({ $0.isNumber || $0 == "." }) else { return nil }
    return words[1] == "null" ? "brew install cocoapods" : "gem install cocoapods -v \(here)"
  }

  /// The text line under the machine's name when it has no resources to show: `detail`, empty for a request waiting
  /// for approval and when the listed problems already say why builds stay on this Mac.
  public var rowDetail: String {
    guard state == .approved else { return state == .pending ? "" : detail }
    if let capacity, !capacity.resources.isEmpty { return "" }
    return problemLines.isEmpty ? detail : ""
  }

  /// For a request waiting for approval: the command a person runs on that Mac to approve this one, when doctor
  /// reported the request's id.
  public var approvalCommand: String? {
    guard state == .pending, let deviceId else { return nil }
    return "stim-server devices grant \(deviceId) --build"
  }

  /// When a request waiting for approval lapses, as stim-server sets it.
  public static let requestLapse = "The request lapses after 15 minutes."

  public func lapseLine(timeZone: TimeZone = .current, locale: Locale = .current) -> String {
    guard let expiresAt, let date = Self.parseTimestamp(expiresAt) else { return Self.requestLapse }
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.timeZone = timeZone
    formatter.timeStyle = .short
    formatter.dateStyle = .none
    return "Waiting for approval until \(formatter.string(from: date))."
  }

  private static func parseTimestamp(_ text: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
  }

  /// Who approves a request waiting for approval, and where; `detail` and the settings row continue it.
  public var approvalPrompt: String { "Someone on \(machine) approves it in Stim Desktop" }

  public var detail: String {
    switch state {
    case .approved:
      if offloadable != false { return "Builds can run on this Mac." }
      return readiness.remedy.map { $0.prefix(1).uppercased() + $0.dropFirst() + "." } ?? "Builds stay on this Mac for now."
    case .pending:
      let grant = approvalCommand.map { " or runs \($0) there" } ?? ""
      return "\(approvalPrompt)\(grant). \(lapseLine())"
    case .notAsked: return "This Mac has not asked it yet."
    case .revoked: return "It revoked this Mac or denied the request."
    case .lapsed: return "The request lapsed before anyone on \(machine) approved it. Ask again."
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

/// One resource of a remote Mac, shown like the toolbar's resource summary item of the same kind.
public struct MachineResource: Equatable, Sendable {
  public var kind: ResourceKind
  public var label: String
  public var value: String
  public var tone: Tone
}

/// The pill text and tone of a remote Mac in the list.
public struct MachineListStatus: Equatable, Sendable {
  public var title: String
  public var tone: Tone
}

/// What a listed remote Mac does for this Mac: it always builds, and hosts simulators when its device-host access
/// is approved. `hosts` is the doctor report's `deviceHosts`, nil when unknown.
public func buildMachineCapabilities(_ machine: String, hosts: [BuildMachineStatus]?) -> [String] {
  let name = OffloadMachines.name(machine)
  let simulators = hosts?.contains { $0.state == .approved && OffloadMachines.name($0.machine) == name } == true
  return simulators ? ["Builds", "Simulators"] : ["Builds"]
}

/// A remote Mac's readiness for builds, as `BuildMachineStatus.readiness` reads it from `stim doctor`.
public struct MachineReadiness: Equatable, Sendable {
  public var title: String
  public var remedy: String?
  public var tone: Tone
  public var reasons: String?

  /// `Stim build differs \u{2014} update the remote Mac`, or the title alone.
  public var line: String { remedy.map { "\(title) \u{2014} \($0)" } ?? title }

  /// The short title and remedy of each `stim doctor` build-machine reason code; `busy` is built from the load.
  static let problems: [String: (String, String)] = {
    let sdk = "install it with sdkmanager there"
    return [
      "unreachable": ("Not answering", "check its stim-server"),
      "checkout": ("Not a git checkout", "run Stim from a git checkout"),
      "stim-build": ("Stim build differs", "update the remote Mac"),
      "arch": ("Other CPU", "use a Mac with the same CPU"),
      "xcode": ("Xcode differs", "select the same Xcode on both"),
      "simulator-sdk": ("Simulator SDK differs", "select the same Xcode on both"),
      "cocoapods": ("CocoaPods differs", "install the same CocoaPods there"),
      "bundler": ("No Bundler", "install Bundler there"),
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

/// `remote.machines` edits, as the JSON text `stim settings set` takes.
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
