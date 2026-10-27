import Foundation

/// Where an update of another Mac's stim-server stands, as the local stim-server's `machines.update.status` reports
/// it: the host's own `server.update.status`, why it could not be read, and how much of this Mac's build went out.
public struct MachineUpdateStatus: Decodable, Equatable, Sendable {
  public struct Remote: Decodable, Equatable, Sendable {
    public struct Server: Decodable, Equatable, Sendable {
      public var version: String?
      public var stimBuild: String?
    }

    public var server: Server?
    /// The stim-server service label it runs under; nil when it does not run as a service and cannot update itself.
    public var service: String?
    public var running: Running?
    public var last: Outcome?
    public var acceptsClientBuilds: Bool
  }

  public struct Running: Decodable, Equatable, Sendable {
    public var state: String
    public var startedAt: String
    public var log: [String]
  }

  public struct Outcome: Decodable, Equatable, Sendable {
    public var at: String
    public var ok: Bool
    public var message: String
  }

  public struct Upload: Decodable, Equatable, Sendable {
    public var sent: Int
    public var total: Int
    public var error: String?
  }

  public var remote: Remote?
  public var unreachable: String?
  public var upload: Upload?

  public init(remote: Remote? = nil, unreachable: String? = nil, upload: Upload? = nil) {
    self.remote = remote
    self.unreachable = unreachable
    self.upload = upload
  }
}

/// The phase Desktop shows for one update it asked for.
public enum MachineUpdatePhase: Equatable, Sendable {
  case sending(Double)
  case installing(String?)
  /// The host waits for its offloaded builds and hosted sessions to end before it restarts.
  case waiting(builds: Int, hostedSessions: Int)
  case restarting
  case finished(String)
  case failed(String)

  public var isDone: Bool {
    switch self {
    case .finished, .failed: return true
    default: return false
    }
  }

  public var line: String {
    switch self {
    case .sending(let fraction): return "Sending this Mac's build (\(Format.int((fraction * 100).rounded()))%)\u{2026}"
    case .installing(let line): return line ?? "Installing\u{2026}"
    case .waiting(let builds, let sessions):
      let work = [
        builds > 0 ? "\(builds) offloaded \(builds == 1 ? "build" : "builds")" : nil,
        sessions > 0 ? "\(sessions) hosted \(sessions == 1 ? "simulator" : "simulators")" : nil,
      ].compactMap { $0 }
      return "Waiting for \(work.joined(separator: " and ")) to end\u{2026}"
    case .restarting: return "Restarting its stim-server\u{2026}"
    case .finished(let message): return message
    case .failed(let message): return message
    }
  }

  /// The phase of the update the host started at `startedAt` (its own clock), from one status read. An outcome
  /// recorded at or after that time ends it, and so does a host that already runs `expectedBuild`, which another
  /// update can install; until then a host that does not answer is restarting.
  public static func from(
    _ status: MachineUpdateStatus, startedAt: String, expectedBuild: String? = nil
  ) -> MachineUpdatePhase {
    if let error = status.upload?.error { return .failed(error) }
    if let upload = status.upload, upload.sent < upload.total {
      return .sending(upload.total > 0 ? Double(upload.sent) / Double(upload.total) : 0)
    }
    guard let remote = status.remote else { return .restarting }
    if let last = remote.last, last.at >= startedAt {
      return last.ok ? .finished(last.message) : .failed(last.message)
    }
    if let running = remote.running {
      if let line = running.log.last,
        let match = line.wholeMatch(of: /Waiting for (\d+) offloaded build\(s\) and (\d+) hosted session\(s\) to finish\./),
        let builds = Int(match.1), let sessions = Int(match.2)
      {
        return .waiting(builds: builds, hostedSessions: sessions)
      }
      return .installing(running.log.last)
    }
    if let expectedBuild, remote.server?.stimBuild == expectedBuild {
      return .finished("It now runs this Mac's Stim build.")
    }
    return .restarting
  }
}

/// The Stim build an update installs: this Mac's, from doctor's "Stim build <there> there, <here> here" reason.
public func stimBuildHere(_ status: BuildMachineStatus) -> String? {
  guard let reason = status.problems?.first(where: { $0.code == "stim-build" })?.reason,
    let match = reason.wholeMatch(of: /Stim build \S+ there, (\S+) here/), match.1 != "unknown"
  else { return nil }
  return String(match.1)
}

/// Whether `status` says the remote Mac runs another Stim build than this Mac, the case an update fixes.
public func needsStimUpdate(_ status: BuildMachineStatus) -> Bool {
  status.state == .approved && status.problems?.contains { $0.code == "stim-build" } == true
}

/// This Mac's stim-server, whose build an install sends to a remote Mac.
public struct LocalStim: Equatable, Sendable {
  public var version: String
  /// Whether it runs from an installed npm release. A remote Mac installs a release without
  /// `server.acceptClientBuilds`, and a build from a checkout only with it.
  public var isRelease: Bool

  public init(version: String, isRelease: Bool) {
    self.version = version
    self.isRelease = isRelease
  }

  /// Whether `path`, a stim-server script, sits in an installed package, as stim-server tells a release from a
  /// checkout.
  public static func isInstalledPackage(_ path: String) -> Bool {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().pathComponents.contains("node_modules")
  }
}

/// Why this Mac cannot install its Stim build on a remote Mac now, and what the person does about it.
public struct StimInstallBlock: Equatable, Sendable {
  public enum Action: Equatable, Sendable {
    /// This Mac is older than the remote Mac: update Stim Desktop.
    case checkForUpdates
    /// A command the person runs on the remote Mac.
    case runOnRemote(String)
  }

  public var reason: String
  public var action: Action?

  public init(reason: String, action: Action? = nil) {
    self.reason = reason
    self.action = action
  }

  /// Whether the remote Mac runs a newer Stim than this Mac, which only an update of Stim Desktop fixes.
  public var remoteIsNewer: Bool { action == .checkForUpdates }
}

/// Whether Install This Mac's Build would be accepted by the remote Mac.
public enum StimInstall: Equatable, Sendable {
  case install
  case blocked(StimInstallBlock)

  public var block: StimInstallBlock? {
    if case .blocked(let block) = self { return block }
    return nil
  }
}

/// The command in the first backtick span of `message` that starts with `stim`, such as the one a stim-server refusal
/// tells the person to run on its machine.
public func commandToRun(in message: String) -> String? {
  message.split(separator: "`", omittingEmptySubsequences: false).enumerated()
    .first { $0.offset % 2 == 1 && $0.element.hasPrefix("stim") }
    .map { String($0.element) }
}

/// Whether `machine`, which runs another Stim build, would take this Mac's build, from what its stim-server reports
/// about itself (`remote`, nil before it has been read) and this Mac's stim-server (`local`). nil when the machine
/// needs no install. An install only moves a remote Mac forward, so a remote Mac on a newer release is never offered
/// one: the person updates Stim Desktop instead. Nothing here asks the remote Mac to install.
public func stimInstall(for machine: BuildMachineStatus, remote: MachineUpdateStatus?, local: LocalStim?) -> StimInstall? {
  guard needsStimUpdate(machine) else { return nil }
  let name = machine.machine
  func blocked(_ reason: String, _ action: StimInstallBlock.Action? = nil) -> StimInstall {
    .blocked(StimInstallBlock(reason: reason, action: action))
  }
  guard let local else { return blocked("Waiting for this Mac's stim-server to connect\u{2026}") }
  guard let remote else { return blocked("Checking whether \(name) can take this Mac's build\u{2026}") }
  guard let server = remote.remote else {
    let reason = remote.unreachable ?? "\(name) did not answer."
    return blocked(reason, commandToRun(in: reason).map { .runOnRemote($0) })
  }
  if local.isRelease, let there = SemanticVersion(server.server?.version ?? ""), let here = SemanticVersion(local.version),
    here < there
  {
    return blocked(
      "\(name) runs Stim \(there), newer than this Mac (\(here)). Update Stim Desktop to match.", .checkForUpdates)
  }
  if server.service == nil {
    return blocked(
      "stim-server on \(name) was not started by `stim-server service install`, so it cannot update itself. Update it on \(name)."
    )
  }
  if !local.isRelease, !server.acceptsClientBuilds {
    let command = "stim settings set server.acceptClientBuilds true"
    return blocked(
      "\(name) takes only npm releases, and this Mac runs a checkout build. To allow it, run `\(command)` on \(name).",
      .runOnRemote(command))
  }
  return .install
}

/// A device one of this Mac's workspaces runs on a remote machine, and the `stim stop` that ends its session there.
public struct HostedOnMachine: Hashable, Sendable {
  public var workspace: String
  public var device: String
  public var stop: StimCommand

  public init(workspace: String, device: String, stop: StimCommand) {
    self.workspace = workspace
    self.device = device
    self.stop = stop
  }
}

/// The hosted simulators and emulators this Mac's workspaces run on `machine`, a `remote.machines` entry. A hosted
/// macOS app is left out: its `stim stop` ends the whole workspace.
public func hostedDevices(on machine: String, in workspaces: [Workspace]) -> [HostedOnMachine] {
  let name = OffloadMachines.name(machine)
  let same = { (host: String) in
    let other = OffloadMachines.name(host)
    if other == name { return true }
    guard !name.contains(".") || !other.contains(".") else { return false }
    return name.split(separator: ".").first == other.split(separator: ".").first
  }
  return workspaces.flatMap { workspace in
    workspace.devices.compactMap { device -> HostedOnMachine? in
      if case .macos = device { return nil }
      guard let host = device.hostedMachine, same(host) else { return nil }
      return HostedOnMachine(
        workspace: workspace.names.title, device: device.label, stop: stopCommand(for: device, cwd: workspace.path))
    }
  }
}
