import Foundation

/// Where an update of another Mac's stim-server stands, as the local stim-server's `machines.update.status` reports
/// it: the host's own `server.update.status`, why it could not be read, and how much of this Mac's build went out.
public struct MachineUpdateStatus: Decodable, Equatable, Sendable {
  public struct Remote: Decodable, Equatable, Sendable {
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
    case .restarting: return "Restarting its stim-server\u{2026}"
    case .finished(let message): return message
    case .failed(let message): return message
    }
  }

  /// The phase of the update the host started at `startedAt` (its own clock), from one status read. An outcome
  /// recorded at or after that time ends it; until then a host that does not answer is restarting.
  public static func from(_ status: MachineUpdateStatus, startedAt: String) -> MachineUpdatePhase {
    if let error = status.upload?.error { return .failed(error) }
    if let upload = status.upload, upload.sent < upload.total {
      return .sending(upload.total > 0 ? Double(upload.sent) / Double(upload.total) : 0)
    }
    guard let remote = status.remote else { return .restarting }
    if let last = remote.last, last.at >= startedAt {
      return last.ok ? .finished(last.message) : .failed(last.message)
    }
    if let running = remote.running { return .installing(running.log.last) }
    return .restarting
  }
}

/// Whether `status` says the build machine runs another Stim build than this Mac, the case an update fixes.
public func needsStimUpdate(_ status: BuildMachineStatus) -> Bool {
  status.state == .approved && status.problems?.contains { $0.code == "stim-build" } == true
}
