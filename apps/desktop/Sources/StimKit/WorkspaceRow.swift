import Foundation

/// What a workspace is doing, for the trailing word of its sidebar row. `apps/mobile/src/lib/home-list.ts` holds the
/// same rules for the phone's Home list; both replay `Tests/StimKitTests/Fixtures/workspace-row-vectors.json`.
public struct RowStatus: Equatable, Sendable {
  public enum Kind: String, Sendable {
    case building, warming, ready, driven, running, idle
  }

  public var kind: Kind
  public var text: String
  /// `text` spelled out for assistive technology.
  public var label: String
  public var tone: Tone
}

/// Something wrong with a workspace, errors before warnings.
public struct RowProblem: Equatable, Sendable {
  public enum Kind: String, Sendable {
    case errors
    case buildFailed = "build-failed"
    case appClosed = "app-closed"
    case ciFailing = "ci-failing"
    case issues, warnings, supervisor
  }

  public var kind: Kind
  public var text: String
  public var tone: Tone
}

/// A workspace's running devices by kind, the tools driving them, how long they have been idle, and its EAS sessions.
public struct RowDevices: Equatable, Sendable {
  public struct Idle: Equatable, Sendable {
    public var text: String
    public var label: String
  }

  /// Running devices by kind, such as "2 iOS, Android, iOS device".
  public var names: String?
  /// The tools driving any of them, each named once.
  public var drivers: String?
  /// How long since any running device was used, once that is 10 minutes or more and none is driven.
  public var idle: Idle?
  public var remote: Int
}

extension Format {
  /// "45 minutes", "1 hour 5 minutes": `duration` spelled out for assistive technology.
  public static func spokenDuration(_ seconds: TimeInterval) -> String {
    let minutes = Int(max(0, seconds) / 60)
    if minutes < 1 { return "less than a minute" }
    if minutes < 60 { return countLabel(minutes, "minute") }
    let hours = countLabel(minutes / 60, "hour")
    return minutes % 60 == 0 ? hours : "\(hours) \(countLabel(minutes % 60, "minute"))"
  }
}

extension Workspace {
  private var settingUp: Bool { !live && isSettingUp }

  /// Whether the row reads as live: something runs, a build runs, an EAS session or a leased phone is held, or it is
  /// being set up. Wider than `isActive`, which leaves out a workspace held only by an EAS session.
  public var isShownLive: Bool {
    live || build?.isRunning == true || remoteDevices?.isEmpty == false || physicalDevices?.isEmpty == false
      || settingUp
  }

  /// The running local devices in `orderedDevices` order; EAS sessions are counted apart.
  private var runningLocalDevices: [DeviceRef] {
    orderedDevices.filter {
      if case .remote = $0 { return false }
      return $0.isRunning
    }
  }

  private func since(_ text: String?, _ now: Date) -> TimeInterval? {
    text.flatMap(parseTimestamp).map { max(0, now.timeIntervalSince($0)) }
  }

  public func rowStatus(now: Date) -> RowStatus {
    if let build, build.isRunning {
      let text = "Building \(platformName(build.platform))"
      return RowStatus(kind: .building, text: text, label: text, tone: .brand)
    }
    if settingUp {
      if phase == "ready" { return RowStatus(kind: .ready, text: "Ready", label: "Ready", tone: .brand) }
      guard let seconds = since(phaseSince, now) else {
        return RowStatus(kind: .warming, text: "Warming", label: "Warming", tone: .brand)
      }
      return RowStatus(
        kind: .warming, text: "Warming \(Format.duration(seconds))",
        label: "Warming for \(Format.spokenDuration(seconds))", tone: .brand)
    }
    if !isShownLive {
      guard let seconds = since(metro?.lastStop?.at, now) else {
        return RowStatus(kind: .idle, text: "Idle", label: "Idle", tone: .tertiary)
      }
      return RowStatus(
        kind: .idle, text: "Idle \(Format.duration(seconds))", label: "Idle for \(Format.spokenDuration(seconds))",
        tone: .tertiary)
    }
    let driven = runningLocalDevices.filter { $0.activity?.state == "driven" }
    if !driven.isEmpty {
      guard let latest = driven.compactMap({ $0.activity?.driver?.since.flatMap(parseTimestamp) }).max() else {
        return RowStatus(kind: .driven, text: "Driven", label: "Driven by an agent", tone: .brand)
      }
      let seconds = max(0, now.timeIntervalSince(latest))
      return RowStatus(
        kind: .driven, text: "Driven \(Format.duration(seconds))",
        label: "Driven by an agent for \(Format.spokenDuration(seconds))", tone: .brand)
    }
    return RowStatus(kind: .running, text: "Running", label: "Running", tone: .success)
  }

  /// A failed build shows while the workspace is live, or for a day after it failed, as in Needs attention.
  public func rowProblems(now: Date) -> [RowProblem] {
    var problems: [RowProblem] = []
    let errors = logs?.errorsSinceMarker ?? 0
    if errors > 0 { problems.append(RowProblem(kind: .errors, text: countLabel(errors, "error"), tone: .error)) }
    let building = build?.isRunning == true ? build?.platform : nil
    for platform in ["ios", "android"] {
      guard let last = lastBuilds?.build(for: platform), last.status == "failed", building != platform else { continue }
      let age = since(last.finishedAt ?? last.startedAt, now)
      if !isShownLive, age.map({ $0 * 1000 >= staleMs }) ?? true { continue }
      problems.append(RowProblem(kind: .buildFailed, text: "\(platformName(platform)) build failed", tone: .error))
    }
    for device in orderedDevices where appPresence(device) == .closed {
      problems.append(RowProblem(kind: .appClosed, text: "\(platformName(device.platform)) app closed", tone: .error))
    }
    if (worktree?.pullRequest?.checks?.failing ?? 0) > 0 {
      problems.append(RowProblem(kind: .ciFailing, text: "CI failing", tone: .error))
    }
    if !warnings.isEmpty {
      problems.append(
        issues?.contains { $0.severity == "error" } == true
          ? RowProblem(kind: .issues, text: countLabel(warnings.count, "issue"), tone: .error)
          : RowProblem(kind: .warnings, text: countLabel(warnings.count, "warning"), tone: .warning))
    }
    if supervisor?.healthy == false {
      problems.append(RowProblem(kind: .supervisor, text: "Supervisor unhealthy", tone: .warning))
    }
    return problems
  }

  /// The step `stim worktree warm` is on.
  public var warmStepText: String { warmStep == "copy" ? "Copying ignored files" : "Installing dependencies" }

  public func rowDevices(now: Date) -> RowDevices {
    let running = runningLocalDevices
    var kinds: [(name: String, count: Int)] = []
    for device in running {
      let name = platformName(device.platform) + (device.isPhysical ? " device" : "")
      if let index = kinds.firstIndex(where: { $0.name == name }) {
        kinds[index].count += 1
      } else {
        kinds.append((name, 1))
      }
    }
    var tools: [String] = []
    for device in running where device.activity?.state == "driven" {
      let tool = device.activity?.driver?.tool ?? "unknown tool"
      if !tools.contains(tool) { tools.append(tool) }
    }
    var idle: RowDevices.Idle?
    let activities = running.compactMap(\.activity).filter { $0.state != "unknown" }
    if tools.isEmpty, !activities.isEmpty, activities.allSatisfy({ $0.state == "idle" }),
      let last = activities.compactMap({ $0.lastActivityAt.flatMap(parseTimestamp) }).max(),
      now.timeIntervalSince(last) >= ActivityBadge.activeWindow
    {
      let seconds = now.timeIntervalSince(last)
      idle = RowDevices.Idle(
        text: "idle \(Format.duration(seconds))", label: "idle for \(Format.spokenDuration(seconds))")
    }
    return RowDevices(
      names: kinds.isEmpty ? nil : kinds.map { $0.count > 1 ? "\($0.count) \($0.name)" : $0.name }.joined(separator: ", "),
      drivers: tools.isEmpty ? nil : tools.joined(separator: ", "),
      idle: idle,
      remote: remoteDevices?.count ?? 0)
  }
}

extension Workspace {
  /// Everything the sidebar row shows, spoken, since the row is one accessibility element: the state, the agent
  /// session, what is wrong, the build step, each running device and who drives it, EAS sessions, git and the folder.
  /// A driven workspace is spoken through its devices only, so the driver is not said twice.
  public func rowLabel(now: Date, folder: String?, showsGit: Bool) -> String {
    let status = rowStatus(now: now)
    var parts: [String?] = [names.title]
    if status.kind == .building, let build, build.isRunning {
      let (phase, counts) = build.currentPhaseLabel
      parts += [status.label, phase, counts]
    } else if status.kind != .driven {
      parts.append(status.label)
    }
    if status.kind == .warming { parts.append(warmStepText) }
    let sessions = AgentSession.associated(agents: agents, endedAgents: endedAgents)
    if let first = sessions.first { parts.append(first.label + (sessions.count > 1 ? " +\(sessions.count - 1)" : "")) }
    parts += rowProblems(now: now).map(\.text)
    for device in orderedDevices where device.isRunning {
      if case .remote = device { continue }
      let kind = platformName(device.platform) + (device.isPhysical ? " device" : "")
      let name = device.slot == DeviceRef.defaultSlot ? kind : "\(kind) slot \(device.slot)"
      parts.append(ActivityBadge(device.activity, now: now).map { "\(name), \($0.spoken)" } ?? "\(name) running")
    }
    if let remote = remoteDevices, !remote.isEmpty { parts.append(countLabel(remote.count, "EAS session")) }
    if showsGit { parts.append(GitChip(worktree)?.label) }
    parts.append(folder)
    return parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
  }
}

extension ActivityBadge {
  /// `text` for assistive technology, such as "driven by agent-device for 5 minutes".
  public var spoken: String {
    switch self {
    case .driven(let tool, let since):
      return since.map { "driven by \(tool) for \(Format.spokenDuration($0))" } ?? "driven by \(tool)"
    case .idle(let idle):
      return idle.map { "idle for \(Format.spokenDuration($0))" } ?? "idle"
    case .unknown:
      return "activity unknown"
    }
  }
}
