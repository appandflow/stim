import Foundation

/// Where a remote machine's problem or note belongs on its detail page.
public enum MachinePlatform: String, CaseIterable, Sendable {
  case machine, ios, android, macos

  public var title: String {
    switch self {
    case .machine: return "Machine"
    case .ios: return "iOS"
    case .android: return "Android"
    case .macos: return "macOS"
    }
  }

  /// The platform a doctor reason names with its "iOS: " style label, else the one its code belongs to.
  static func of(code: String, label: MachinePlatform?) -> MachinePlatform {
    if let label { return label }
    switch code {
    case "jdk", "android-sdk", "ndk", "build-tools", "compile-sdk": return .android
    case "xcode", "simulator-sdk", "cocoapods", "bundler", "runtime": return .ios
    case "macos-sdk": return .macos
    default: return .machine
    }
  }

  /// `reason` without the platform label doctor prefixes when it judges several platforms, and that platform.
  static func split(_ reason: String) -> (platform: MachinePlatform?, reason: String) {
    for platform in [MachinePlatform.ios, .android, .macos] {
      let prefix = "\(platform.title): "
      if reason.hasPrefix(prefix) { return (platform, String(reason.dropFirst(prefix.count))) }
    }
    return (nil, reason)
  }
}

/// What to do about a problem or note: sentences, and each command to run on the remote machine, one per line.
public struct MachineFix: Equatable, Sendable {
  public var text: [String]
  public var commands: [String]

  public var isEmpty: Bool { text.isEmpty && commands.isEmpty }

  /// Splits a doctor fix, whose command lines follow a "On <machine>, ...:" lead, into sentences and commands. A command
  /// in backticks inside a sentence is offered too.
  public init(parsing fix: String) {
    var text: [String] = []
    var commands: [String] = []
    for line in fix.split(separator: "\n").map(String.init) {
      if wizardFixIsCommand(line) {
        commands.append(line)
      } else {
        text.append(line)
        commands.append(contentsOf: backtickCommands(in: line))
      }
    }
    self.init(text: text, commands: commands)
  }

  public init(text: [String], commands: [String]) {
    self.text = text
    var seen: Set<String> = []
    self.commands = commands.filter { seen.insert($0).inserted }
  }
}

/// The commands a sentence puts in backticks, such as "run `stim-server service install --serve` on mini".
func backtickCommands(in text: String) -> [String] {
  text.split(separator: "`", omittingEmptySubsequences: false).enumerated()
    .filter { $0.offset % 2 == 1 }
    .map { String($0.element) }
    .filter(wizardFixIsCommand)
}

/// One thing doctor found about a remote machine: a problem that keeps builds on this Mac, or a note about what a build
/// there does without stopping.
public struct MachineIssue: Equatable, Identifiable, Sendable {
  public enum Kind: String, Sendable { case problem, note }

  public var kind: Kind
  public var code: String
  public var platform: MachinePlatform
  public var title: String
  public var reason: String
  public var fix: MachineFix?

  public var id: String { "\(kind.rawValue):\(platform.rawValue):\(code):\(reason)" }
}

public struct MachineIssueGroup: Equatable, Identifiable, Sendable {
  public var platform: MachinePlatform
  public var issues: [MachineIssue]
  public var id: MachinePlatform { platform }
}

/// What the lazily read Android doctor report gave for the machine's page.
public enum MachineAndroidReport: Equatable, Sendable {
  /// Not asked for: no workspace to check, or the machine is not approved.
  case idle
  case loading
  case loaded(BuildMachineStatus?, [DoctorReport.Finding])
  case failed(String)
}

public struct MachineDetailRow: Equatable, Identifiable, Sendable {
  public var label: String
  public var value: String
  public var tone: Tone = .normal
  public var id: String { label }
}

/// The state that stops this Mac using the machine, in words: a diagnosis layer or the pairing state.
public struct MachineSituation: Equatable, Sendable {
  public var title: String
  public var message: String
  public var remedy: String?
  public var commands: [String]
  public var tone: Tone
}

/// Everything the page of one remote machine shows, from the doctor reports. Built without the views, so the grouping is
/// the same everywhere it is shown.
public struct MachineDetail: Equatable, Sendable {
  public var entry: String
  public var pill: MachineListStatus?
  public var situation: MachineSituation?
  public var groups: [MachineIssueGroup]
  /// Why the Android report adds nothing yet: it is loading, or it failed.
  public var androidMessage: String?
  public var capacity: [MachineDetailRow]
  public var versions: [MachineDetailRow]
  public var approvals: [MachineDetailRow]

  public struct Input: Sendable {
    public var entry: String
    public var status: BuildMachineStatus?
    public var findings: [DoctorReport.Finding] = []
    public var host: BuildMachineStatus?
    public var hostsSimulators = true
    /// Whether the doctor report listed device-host approvals at all.
    public var hostsKnown = true
    public var android: MachineAndroidReport = .idle
    public var install: StimInstall?
    public var update: MachineUpdatePhase?
    public var thisMacVersion: String?
    public var serverVersion: String?

    public init(entry: String, status: BuildMachineStatus?) {
      self.entry = entry
      self.status = status
    }
  }

  public init(_ input: Input) {
    entry = input.entry
    guard let status = input.status else {
      pill = nil
      situation = nil
      groups = []
      androidMessage = nil
      capacity = []
      versions = []
      approvals = []
      return
    }
    pill = status.pill(install: input.install, update: input.update)
    situation = Self.situation(status)
    var issues = Self.issues(of: status, findings: input.findings, entry: input.entry)
    if input.install?.block?.remoteIsNewer == true {
      for index in issues.indices where issues[index].code == "stim-build" { issues[index].fix = nil }
    }
    switch input.android {
    case .loaded(let android?, let findings):
      let fresh = Self.issues(of: android, findings: findings, entry: input.entry)
      issues = issues.filter { $0.platform != .android } + fresh.filter { $0.platform == .android }
      androidMessage = nil
    case .loaded(nil, _): androidMessage = nil
    case .loading: androidMessage = "Checking the Android tools\u{2026}"
    case .failed(let message): androidMessage = "Could not check the Android tools: \(message)"
    case .idle: androidMessage = nil
    }
    groups = MachinePlatform.allCases.compactMap { platform in
      let found = issues.filter { $0.platform == platform }
      return found.isEmpty ? nil : MachineIssueGroup(platform: platform, issues: found)
    }
    capacity = Self.capacity(status.capacity)
    versions = Self.versions(status, thisMac: input.thisMacVersion, server: input.serverVersion)
    approvals = Self.approvals(status, host: input.host, hostsSimulators: input.hostsSimulators && input.hostsKnown)
  }

  static func situation(_ status: BuildMachineStatus) -> MachineSituation? {
    guard status.state != .approved else { return nil }
    let tone: Tone = status.state == .unknown ? .warning : status.state.readinessTone
    if let diagnosed = status.diagnosed {
      return MachineSituation(
        title: diagnosed.title, message: diagnosed.message, remedy: diagnosed.remedy,
        commands: backtickCommands(in: diagnosed.remedy) + backtickCommands(in: diagnosed.message), tone: tone)
    }
    return MachineSituation(
      title: status.state.title, message: status.detail, remedy: nil, commands: backtickCommands(in: status.detail),
      tone: tone)
  }

  /// Each problem and note of an approved machine, with its fix from the report's findings, in doctor's order with
  /// problems first.
  static func issues(of status: BuildMachineStatus, findings: [DoctorReport.Finding], entry: String) -> [MachineIssue] {
    guard status.state == .approved else { return [] }
    let problems = (status.problems ?? []).map { issue($0, kind: .problem, findings: findings, entry: entry) }
    let notes = (status.notes ?? []).map { issue($0, kind: .note, findings: findings, entry: entry) }
    return problems + notes
  }

  private static func issue(
    _ item: BuildMachineStatus.Problem, kind: MachineIssue.Kind, findings: [DoctorReport.Finding], entry: String
  ) -> MachineIssue {
    let (label, reason) = MachinePlatform.split(item.reason)
    let finding = findings.first { finding in
      finding.code == "build-machine-\(item.code)"
        && ["Remote machine", "Remote Mac"].contains { finding.title.hasPrefix("\($0) \(entry) ") }
        && finding.detail.contains(reason)
    }
    var fix = finding?.fix.map { MachineFix(parsing: $0) } ?? MachineFix(text: [], commands: [])
    if fix.commands.isEmpty, item.code == "cocoapods", let command = BuildMachineStatus.cocoapodsFix(reason) {
      fix.commands = [command]
    }
    if fix.isEmpty, kind == .problem, let advice = MachineReadiness.problems[item.code]?.1 {
      fix.text = [advice.prefix(1).uppercased() + advice.dropFirst() + "."]
    }
    return MachineIssue(
      kind: kind, code: item.code, platform: MachinePlatform.of(code: item.code, label: label),
      title: title(item.code, kind: kind), reason: item.code == "stim-build" ? BuildMachineStatus.shortStimBuild(reason) : reason,
      fix: fix.isEmpty ? nil : fix)
  }

  private static func title(_ code: String, kind: MachineIssue.Kind) -> String {
    if kind == .note {
      switch code {
      case "ndk": return "NDK downloads on the first build"
      case "build-tools": return "Build-tools download on the first build"
      case "compile-sdk": return "Android platform downloads on the first build"
      default: return "Downloads on the first build"
      }
    }
    switch code {
    case "busy": return "Busy"
    case "macos-sdk": return "macOS SDK differs"
    default: return MachineReadiness.problems[code]?.0 ?? "Cannot take builds"
    }
  }

  private static func capacity(_ capacity: BuildMachineStatus.Capacity?) -> [MachineDetailRow] {
    guard let capacity else { return [] }
    var rows = capacity.resources.map { MachineDetailRow(label: $0.label, value: $0.value, tone: $0.tone) }
    if let cpus = capacity.cpus { rows.append(MachineDetailRow(label: "Cores", value: "\(cpus)")) }
    if let builds = capacity.buildsText { rows.append(MachineDetailRow(label: "Builds running", value: builds)) }
    if let running = capacity.running, let max = capacity.max {
      rows.append(MachineDetailRow(label: "Offloaded builds", value: "\(running) of \(max)"))
    }
    return rows
  }

  private static func versions(_ status: BuildMachineStatus, thisMac: String?, server: String?) -> [MachineDetailRow] {
    var rows: [MachineDetailRow] = []
    if let thisMac { rows.append(MachineDetailRow(label: "This Mac", value: "Stim \(thisMac)")) }
    if let server { rows.append(MachineDetailRow(label: status.machine, value: "stim-server \(server)")) }
    guard status.state == .approved, status.offloadable != nil else { return rows }
    if let mismatch = status.problems?.first(where: { $0.code == "stim-build" }) {
      rows.append(
        MachineDetailRow(
          label: "Build compatibility", value: BuildMachineStatus.shortStimBuild(mismatch.reason), tone: .warning))
    } else if !(status.problems ?? []).contains(where: { $0.code == "unreachable" || $0.code == "checkout" }) {
      rows.append(MachineDetailRow(label: "Build compatibility", value: "Same as this Mac", tone: .success))
    }
    return rows
  }

  private static func approvals(_ status: BuildMachineStatus, host: BuildMachineStatus?, hostsSimulators: Bool)
    -> [MachineDetailRow]
  {
    var rows = [MachineDetailRow(label: "Builds", value: status.state.title, tone: status.state.readinessTone)]
    if hostsSimulators {
      rows.append(
        MachineDetailRow(
          label: "Hosted simulators", value: host?.state.title ?? "Not requested",
          tone: host?.state.readinessTone ?? .neutral))
    }
    return rows
  }
}

extension BuildMachineStatus {
  /// The one pill the machine shows, in the list and on its page: Updating while Desktop updates it, Update this Mac when
  /// the machine runs a newer Stim, else `listStatus`. Notes never change it.
  public func pill(install: StimInstall?, update: MachineUpdatePhase?) -> MachineListStatus {
    if let update, !update.isDone, needsStimUpdate(self) { return MachineListStatus(title: "Updating", tone: .warning) }
    let listed = listStatus
    if install?.block?.remoteIsNewer == true { return MachineListStatus(title: "Update this Mac", tone: listed.tone) }
    return listed
  }
}
