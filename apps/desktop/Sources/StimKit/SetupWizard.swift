import CryptoKit
import Foundation
import Security

public enum SetupCapability: String, Codable, CaseIterable, Hashable, Sendable {
  case build
  case deviceHost = "device-host"
}

public struct SetupTicket: Equatable, Sendable {
  public var value: String
  public var expiresAt: Date
  public var hash: String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
  public var isoExpires: String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"
    return formatter.string(from: expiresAt)
  }

  public static func generate(
    now: Date = Date(),
    randomBytes: (inout [UInt8]) -> Void = { bytes in
      precondition(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess)
    }
  ) -> SetupTicket {
    var bytes = [UInt8](repeating: 0, count: 32)
    randomBytes(&bytes)
    let value = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    return SetupTicket(value: value, expiresAt: now.addingTimeInterval(30 * 60))
  }
}

public struct SetupJournal: Decodable, Equatable, Sendable {
  public struct Client: Decodable, Equatable, Sendable {
    public var nodeId: String
  }
  public struct Step: Decodable, Equatable, Sendable {
    public enum State: String, Decodable, Sendable {
      case pending, running, ok, skipped, failed
      public init(from decoder: Decoder) throws {
        self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .pending
      }
    }
    public var id: String
    public var state: State
    public var title: String
    public var detail: String?
    public var fix: String?

    public init(id: String, state: State, title: String, detail: String? = nil, fix: String? = nil) {
      self.id = id
      self.state = state
      self.title = title
      self.detail = detail
      self.fix = fix
    }
  }
  public struct Grant: Decodable, Equatable, Sendable {
    public var capability: SetupCapability
    public var id: String

    public init(capability: SetupCapability, id: String) {
      self.capability = capability
      self.id = id
    }
  }
  public var v: Int
  public var client: Client
  public var expiresAt: String
  public var capabilities: [SetupCapability]
  public var steps: [Step]
  public var granted: [Grant]
  public var done: Bool
  public var exit: Int?

  public init(
    nodeId: String, ticket: SetupTicket, capabilities: Set<SetupCapability>, steps: [Step], granted: [Grant] = [],
    done: Bool = false, exit: Int? = nil
  ) {
    v = 1
    client = Client(nodeId: nodeId)
    expiresAt = ticket.isoExpires
    self.capabilities = SetupCapability.allCases.filter { capabilities.contains($0) }
    self.steps = steps
    self.granted = granted
    self.done = done
    self.exit = exit
  }
}

public struct SetupKnown: Equatable, Sendable {
  public var serverVersion: String?
  public var buildApproved: Bool
  public var hostApproved: Bool
  public var screenRecordingGranted: Bool?
  public var deviceControlGranted: Bool?
  public var clientName: String

  public init(
    serverVersion: String? = nil, buildApproved: Bool = false, hostApproved: Bool = false,
    screenRecordingGranted: Bool? = nil, deviceControlGranted: Bool? = nil, clientName: String = "this Mac"
  ) {
    self.serverVersion = serverVersion
    self.buildApproved = buildApproved
    self.hostApproved = hostApproved
    self.screenRecordingGranted = screenRecordingGranted
    self.deviceControlGranted = deviceControlGranted
    self.clientName = clientName
  }

  public func needsApproval(_ capability: SetupCapability) -> Bool {
    capability == .build ? !buildApproved : !hostApproved
  }
}

public func setupCommand(
  version: String, client: String, ticket: SetupTicket, capabilities: Set<SetupCapability>, known: SetupKnown
) -> String {
  let flags = SetupCapability.allCases.filter { capabilities.contains($0) && known.needsApproval($0) }
    .map { "--\($0.rawValue)" }
  return
    ([
      "npx --yes --package @stim-cli/server@\(version) stim-server setup", "--client \(client)",
      "--ticket \(ticket.value)", "--expires \(ticket.isoExpires)",
    ] + flags).joined(separator: " \\\n  ")
}

public func previewLines(capabilities: Set<SetupCapability>, known: SetupKnown, version: String? = nil) -> [TerminalLine] {
  func check(_ title: String, done: Bool = false) -> TerminalLine {
    TerminalLine(text: title + (done ? " (already done)" : ""), kind: .ok)
  }
  var lines = [TerminalLine(text: "$ stim-server setup", kind: .command)]
  guard !capabilities.isEmpty else { return lines }
  lines += [
    check("stim-server \(known.serverVersion ?? version ?? "<version>") installed", done: known.serverVersion != nil),
    check("Stim Host installed"), check("LaunchAgent running"), check("tailnet route https 7443 (no Funnel)"),
  ]
  if capabilities.contains(.build) { lines.append(check("approved \(known.clientName) for builds", done: known.buildApproved)) }
  if capabilities.contains(.deviceHost) {
    lines.append(check("approved \(known.clientName) for hosted simulators", done: known.hostApproved))
    lines.append(check("Screen recording permission", done: known.screenRecordingGranted == true))
    lines.append(check("Device control permission", done: known.deviceControlGranted == true))
  }
  return lines
}

/// The setup journal as short lines in the preview's wording: no node or request ids, no tool details.
public func journalLines(_ journal: SetupJournal, clientName: String) -> [TerminalLine] {
  [TerminalLine(text: "$ stim-server setup", kind: .command)]
    + journal.steps.compactMap { setupStepLine($0, clientName: clientName) }
}

/// One journal step in the preview's wording, with its state as the line's kind; nil for steps the mirror hides.
public func setupStepLine(_ step: SetupJournal.Step, clientName: String) -> TerminalLine? {
  let kind: TerminalLine.Kind
  switch step.state {
  case .ok: kind = .ok
  case .failed: kind = .failed
  case .skipped: kind = .skipped
  case .running, .pending: kind = .pending
  }
  let running = step.state == .running
  let text: String
  switch step.id {
  case "summary": return nil
  case "preflight": text = running ? "checking the tailnet node" : "tailnet node verified"
  case "server":
    if step.state == .ok, step.title.hasPrefix("stim-server ") {
      text = step.title.hasSuffix(" installed") ? step.title : step.title + " installed"
    } else {
      text = running ? "installing stim-server" : "stim-server"
    }
  case "host": text = running ? "installing Stim Host" : "Stim Host installed"
  case "service": text = running ? "starting the LaunchAgent" : "LaunchAgent running"
  case "route":
    let port = step.detail?.range(of: "https port ").map { step.detail![$0.upperBound...] }.map(String.init)
    text = running ? "checking the tailnet route" : port.map { "tailnet route https \($0) (no Funnel)" } ?? "tailnet route"
  case "approve":
    if step.state == .ok { return nil }
    text = running ? "waiting for approval in Terminal" : "approval missing"
  case "approve.build", "approve.device-host":
    let what = step.id == "approve.build" ? "builds" : "hosted simulators"
    switch step.state {
    case .ok: text = "approved \(clientName) for \(what)" + (step.title.hasPrefix("Already") ? " (already done)" : "")
    case .failed: text = "\(what) refused"
    default: text = "approving \(clientName) for \(what)"
    }
  case "permissions.screenRecording", "permissions.deviceControl":
    let name = step.id == "permissions.screenRecording" ? "Screen recording permission" : "Device control permission"
    switch step.state {
    case .skipped: text = name + " skipped"
    case .running: text = name + ": click Allow on that Mac"
    case .pending: text = name + " not granted"
    default: text = name
    }
  case "tools":
    if step.state == .ok { return nil }
    text = "checking tools"
  case "journal": text = "setup journal not written"
  default:
    if step.id.hasPrefix("tools.") {
      let tool = String(step.id.dropFirst("tools.".count))
      text = step.state == .ok ? tool : tool + " missing"
    } else {
      text = step.title
    }
  }
  return TerminalLine(
    text: step.state == .failed && step.id != "approve.build" && step.id != "approve.device-host" ? text + " failed" : text,
    kind: kind)
}

public enum SetupPortProbe {
  public enum Outcome: Equatable, Sendable {
    case journal(SetupJournal)
    case notReady, notFound, unreachable
  }
  public enum Result: Equatable, Sendable {
    case found(port: Int, journal: SetupJournal)
    case serverNotReady, notYet
  }
  public static func resolve(_ outcomes: [Int: Outcome]) -> Result {
    for port in outcomes.keys.sorted() {
      if case .journal(let journal) = outcomes[port] { return .found(port: port, journal: journal) }
    }
    return outcomes.values.contains(.notReady) ? .serverNotReady : .notYet
  }
  public static func entry(machine: String, port: Int) -> String {
    port == 7443 ? machine : "\(machine):\(port)"
  }
  public static func manualPort(_ text: String) -> Int? {
    guard let port = Int(text), (1...65535).contains(port) else { return nil }
    return port
  }
}

public struct SetupWizard: Sendable {
  public enum Phase: Equatable, Sendable { case pick, choose, command, running, approved, cancelled, expiredCommand }
  public enum Failure: Equatable, Sendable {
    case noAnswer, expired, requestLapsed, noWorkspace
    case stepFailed(step: String, detail: String?, fix: String?)
    case serverTooOld(fix: String?)
    case grantedOther(capability: SetupCapability, journalId: String, doctorId: String)
    case funneled(fix: String)
    case permissionSkipped(feature: String)
  }
  public struct Settings: Equatable, Sendable {
    public var builds: [String]
    public var hosts: [String]
    public var mode: String?
    public var modeOrigin: String?
    public init(builds: [String] = [], hosts: [String] = [], mode: String? = nil, modeOrigin: String? = nil) {
      self.builds = builds
      self.hosts = hosts
      self.mode = mode
      self.modeOrigin = modeOrigin
    }
  }
  public enum Event: Sendable {
    case macChosen(TailnetMac)
    case capabilitiesChanged(Set<SetupCapability>)
    case next(SetupTicket)
    case journalAnswered(port: Int, journal: SetupJournal)
    case journalUnavailable
    case doctorReported(build: BuildMachineStatus?, host: BuildMachineStatus?)
    case entriesWritten
    case cancel
    case newCommand(SetupTicket)
    case manualPort(Int)
    case tick
  }
  public enum Effect: Equatable, Sendable {
    case writeEntries(port: Int)
    case askDoctor(ticket: String)
    case restoreSettings, forgetPairing
  }

  public private(set) var phase: Phase = .pick
  public private(set) var mac: TailnetMac?
  public private(set) var capabilities: Set<SetupCapability> = [.build, .deviceHost]
  public private(set) var ticket: SetupTicket?
  public private(set) var commandIssuedAt: Date?
  public private(set) var port: Int?
  public private(set) var journal: SetupJournal?
  public private(set) var build: BuildMachineStatus?
  public private(set) var host: BuildMachineStatus?
  public private(set) var entriesWritten = false
  public private(set) var modeChanged = false
  public private(set) var revokeIds: Set<String> = []
  public var settings: Settings
  public var hasWorkspace: Bool
  private var writeRequested = false
  private var lastAsk: Date?
  private var existingIds: [SetupCapability: String] = [:]
  private var preStateKnown = false

  public init(settings: Settings = Settings(), hasWorkspace: Bool = true) {
    self.settings = settings
    self.hasWorkspace = hasWorkspace
  }

  public var known: SetupKnown {
    SetupKnown(
      buildApproved: hasApproval(.build), hostApproved: hasApproval(.deviceHost),
      screenRecordingGranted: host?.host?.screenRecording, deviceControlGranted: host?.host?.accessibility)
  }

  public mutating func apply(_ event: Event, now: Date) -> [Effect] {
    switch event {
    case .macChosen(let mac):
      guard phase == .pick else { return [] }
      self.mac = mac
      phase = .choose
    case .capabilitiesChanged(let capabilities):
      guard phase == .choose else { return [] }
      self.capabilities = capabilities
    case .next(let ticket), .newCommand(let ticket):
      guard mac != nil, !capabilities.isEmpty, phase != .cancelled else { return [] }
      let previouslyKnown = known
      existingIds = [:]
      self.ticket = ticket
      commandIssuedAt = now
      journal = nil
      lastAsk = nil
      phase = .command
      for capability in capabilities {
        let status = status(for: capability)
        if !previouslyKnown.needsApproval(capability), let id = status?.deviceId { existingIds[capability] = id }
      }
    case .journalAnswered(let port, let journal):
      guard ticket != nil, phase != .cancelled else { return [] }
      self.port = port
      self.journal = journal
      revokeIds.formUnion(journal.granted.map(\.id))
      phase = .running
      if !hasWorkspace { return [] }
      if entriesWritten, lastAsk == nil, let ticket {
        lastAsk = now
        return [.askDoctor(ticket: ticket.value)]
      }
      if !writeRequested {
        writeRequested = true
        modeChanged =
          capabilities.contains(.build) && settings.builds.isEmpty
          && (settings.modeOrigin == nil || settings.modeOrigin == "default")
        return [.writeEntries(port: port)]
      }
    case .entriesWritten:
      entriesWritten = true
      lastAsk = now
      if let ticket { return [.askDoctor(ticket: ticket.value)] }
    case .doctorReported(let build, let host):
      self.build = build
      self.host = host
      if ticket == nil { preStateKnown = true }
      if ticket != nil, preStateKnown {
        for capability in capabilities {
          if let id = status(for: capability)?.deviceId, id != existingIds[capability] { revokeIds.insert(id) }
        }
      }
    case .cancel:
      phase = .cancelled
      if writeRequested { return [.restoreSettings, .forgetPairing] }
    case .manualPort(let port):
      if (1...65535).contains(port), !entriesWritten { self.port = port }
    case .journalUnavailable: break
    case .tick: break
    }
    if ticket != nil, phase != .cancelled, allApproved {
      phase = .approved
    } else if let ticket, now >= ticket.expiresAt, phase != .cancelled {
      phase = .expiredCommand
    }
    if phase == .running, entriesWritten, isLapsed, let ticket, now < ticket.expiresAt,
      lastAsk.map({ now.timeIntervalSince($0) >= 30 }) ?? true
    {
      lastAsk = now
      return [.askDoctor(ticket: ticket.value)]
    }
    return []
  }

  private func hasApproval(_ capability: SetupCapability) -> Bool {
    let status = status(for: capability)
    guard status?.state == .approved, let id = status?.deviceId else { return false }
    if phase == .pick || phase == .choose { return true }
    return id == grantedId(for: capability)
  }

  private func status(for capability: SetupCapability) -> BuildMachineStatus? { capability == .build ? build : host }
  private func grantedId(for capability: SetupCapability) -> String? {
    journal?.granted.first { $0.capability == capability }?.id ?? existingIds[capability]
  }
  private var allApproved: Bool {
    capabilities.allSatisfy { capability in
      let status = status(for: capability)
      return status?.state == .approved && status?.deviceId != nil && status?.deviceId == grantedId(for: capability)
    }
  }
  private var isLapsed: Bool {
    journal?.done == false
      && capabilities.contains { capability in
        let state = status(for: capability)?.state
        return state == .notAsked || state == .revoked
      }
  }

  public func failure(now: Date) -> Failure? {
    if !hasWorkspace, phase != .pick { return .noWorkspace }
    for capability in SetupCapability.allCases where capabilities.contains(capability) {
      if let grant = journal?.granted.first(where: { $0.capability == capability }),
        let id = status(for: capability)?.deviceId, grant.id != id
      {
        return .grantedOther(capability: capability, journalId: grant.id, doctorId: id)
      }
    }
    if !allApproved, ticket.map({ now >= $0.expiresAt }) == true {
      return .expired
    }
    if let step = journal?.steps.first(where: { $0.state == .failed }) {
      if step.id == "server", step.detail?.contains("predates setup support") == true { return .serverTooOld(fix: step.fix) }
      if step.id == "route", let fix = step.fix, fix.hasPrefix("tailscale funnel") { return .funneled(fix: fix) }
      return .stepFailed(step: step.title, detail: step.detail, fix: step.fix)
    }
    if capabilities.contains(.deviceHost), let journal {
      for (id, feature, granted) in [
        ("permissions.screenRecording", "Hosted simulators cannot be viewed", host?.host?.screenRecording),
        ("permissions.deviceControl", "Hosted simulators cannot be controlled", host?.host?.accessibility),
      ] {
        if let step = journal.steps.first(where: { $0.id == id }), granted != true,
          step.state == .skipped || (journal.done && step.state == .pending)
        {
          return .permissionSkipped(feature: feature)
        }
      }
    }
    if isLapsed, let ticket, now < ticket.expiresAt { return .requestLapsed }
    if journal == nil, let issued = commandIssuedAt, now.timeIntervalSince(issued) >= 180 { return .noAnswer }
    return nil
  }
}

/// The wizard's pages after setup; `setup` covers picking a Mac, choosing capabilities and the setup command.
public enum SetupPage: Sendable { case setup, tools, test, summary }

/// What the wizard reads again in the background; it has no Check again button.
public enum SetupRefresh: Hashable, Sendable {
  /// `tailscale status` and the peers' health.
  case peers
  /// This Mac's existing approvals on the chosen Mac, before the command.
  case approvals
  /// The setup journal on the chosen Mac.
  case journal
  /// `stim doctor` for the requests this run made.
  case doctor
  /// The chosen Mac's tools.
  case tools

  public var interval: TimeInterval {
    switch self {
    case .journal: return 1
    case .peers, .doctor: return 5
    case .approvals: return 10
    case .tools: return 10
    }
  }
}

extension SetupWizard {
  /// The reads that keep `page` current. Nothing refreshes once the test starts or setup is cancelled.
  public func refreshes(page: SetupPage) -> [SetupRefresh] {
    switch page {
    case .tools: return [.tools]
    case .test, .summary: return []
    case .setup: break
    }
    switch phase {
    case .pick: return [.peers]
    case .choose: return [.approvals]
    case .cancelled: return []
    case .command, .running, .approved, .expiredCommand:
      var reads: [SetupRefresh] = phase == .expiredCommand ? [] : [.journal]
      if journal != nil, entriesWritten { reads.append(.doctor) }
      return reads
    }
  }
}

/// When each background read last ran, so `due` returns only the reads whose interval has passed.
public struct SetupRefreshClock: Sendable {
  private var last: [SetupRefresh: Date] = [:]
  public init() {}

  public mutating func due(_ reads: [SetupRefresh], now: Date) -> [SetupRefresh] {
    let due = reads.filter { read in last[read].map { now.timeIntervalSince($0) >= read.interval } ?? true }
    for read in due { last[read] = now }
    return due
  }

  public mutating func ran(_ read: SetupRefresh, now: Date) { last[read] = now }

  /// Marks every read in `reads` as run now.
  public mutating func ran(_ reads: [SetupRefresh], now: Date) {
    for read in reads { last[read] = now }
  }
}
