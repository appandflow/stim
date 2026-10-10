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
    case .sending(let fraction): return "Sending this Mac's build (\(Int((fraction * 100).rounded()))%)\u{2026}"
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

/// The hosted devices this Mac's workspaces run on `machine`, a `remote.machines` entry.
public func hostedDevices(on machine: String, in workspaces: [Workspace]) -> [HostedOnMachine] {
  let label = { (entry: String) in OffloadMachines.name(entry).split(separator: ".").first.map(String.init) }
  let name = label(machine)
  return workspaces.flatMap { workspace in
    workspace.devices.compactMap { device -> HostedOnMachine? in
      guard let host = device.hostedMachine, label(host) == name else { return nil }
      return HostedOnMachine(
        workspace: workspace.names.title, device: device.label, stop: stopCommand(for: device, cwd: workspace.path))
    }
  }
}
