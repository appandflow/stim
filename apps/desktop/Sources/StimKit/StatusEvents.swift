import Foundation

/// Something worth a notification, found by comparing two `stim status` payloads.
public struct StatusEvent: Hashable, Sendable {
  public enum Kind: String, CaseIterable, Sendable {
    case build, errors, crash, memory, remoteSession

    public var title: String {
      switch self {
      case .build: return "A build finishes or fails"
      case .errors: return "A workspace logs new errors"
      case .crash: return "A simulator or emulator stops unexpectedly"
      case .memory: return "Live workspaces exceed the machine's memory"
      case .remoteSession: return "A remote EAS session is still running"
      }
    }
  }

  public var kind: Kind
  public var id: String
  public var title: String
  public var body: String
}

public enum StatusEvents {
  /// Events between `previous` and `current`. A remote session is reported
  /// once, when it first passes `remoteMinutes`; `reported` holds the ids of
  /// the remote-session events already posted.
  public static func events(
    previous: StatusPayload, current: StatusPayload, now: Date, remoteMinutes: Int, reported: Set<String>
  ) -> [StatusEvent] {
    var events: [StatusEvent] = []
    let before = Dictionary(previous.environments.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
    for env in current.environments {
      let name = env.names.title
      if let old = before[env.path] {
        if let build = old.build, build.isRunning, env.build?.isRunning != true || env.build?.startedAt != build.startedAt {
          events.append(buildEvent(build, now: env.build, workspace: env, name: name))
        }
        let oldErrors = old.logs?.errorsSinceMarker ?? 0
        if let errors = env.logs?.errorsSinceMarker, errors > oldErrors {
          let added = errors - oldErrors
          events.append(
            StatusEvent(
              kind: .errors, id: "errors:\(env.path):\(errors)", title: "\(name): \(added == 1 ? "1 new error" : "\(added) new errors")",
              body: "\(errors) since the last marker in \(env.path)"))
        }
        let running = Set(env.devices.filter(\.isRunning).map(\.id))
        let stillServing = env.metro?.running == true || env.supervisor != nil
        for device in old.devices where device.isRunning && !running.contains(device.id) && stillServing {
          if case .remote = device { continue }
          if env.build?.isRunning == true { continue }
          events.append(
            StatusEvent(
              kind: .crash, id: "crash:\(device.id):\(now.timeIntervalSince1970)",
              title: "\(name): \(device.model) stopped",
              body: "Its dev server is still running, so the device stopped without stim stop."))
        }
      }
      for remote in env.remoteDevices ?? [] where !reported.contains("remote:\(remote.sessionId)") {
        guard let started = remote.startedAt.flatMap(parseTimestamp) else { continue }
        let minutes = Int(now.timeIntervalSince(started) / 60)
        guard minutes >= remoteMinutes else { continue }
        events.append(
          StatusEvent(
            kind: .remoteSession, id: "remote:\(remote.sessionId)",
            title: "\(name): EAS session running for \(minutes) min",
            body: "Session \(remote.sessionId) is billed while it runs. stim stop in the workspace ends it."))
      }
    }
    if let cap = current.capacity, cap.overCapacity, previous.capacity?.overCapacity != true {
      events.append(
        StatusEvent(
          kind: .memory, id: "memory:\(now.timeIntervalSince1970)", title: "Over memory capacity",
          body: "\(cap.liveCount) live workspaces commit \(cap.committedMb) MB of \(cap.totalMemoryMb) MB."))
    }
    return events
  }

  private static func buildEvent(_ build: Build, now: Build?, workspace: Workspace, name: String) -> StatusEvent {
    let id = "build:\(workspace.path):\(build.startedAt)"
    if now?.startedAt == build.startedAt, now?.state == "stale" {
      return StatusEvent(
        kind: .build, id: id, title: "\(name): \(build.platform) build failed",
        body: "The run ended during \(build.phase) without finishing.")
    }
    if build.phase == "launch" || build.phase == "install" {
      return StatusEvent(
        kind: .build, id: id, title: "\(name): \(build.platform) build finished", body: "The app was installed.")
    }
    return StatusEvent(
      kind: .build, id: id, title: "\(name): \(build.platform) build ended during \(build.phase)",
      body: "It stopped before installing. stim logs --errors --source build shows why.")
  }
}

func parseTimestamp(_ text: String) -> Date? {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
}
