import Foundation

public struct TutorialEnvironment: Sendable {
  public var path: String
  public var version: Int
  public var phase: String?
  public var phaseSince: Date?
  public var live: Bool
  public var build: Build?
  public var builds: [BuildHistoryEntry]
  public var lastBuild: LastBuild?
  public var ios: IosDevice?
  public var errorsSinceMarker: Int?
  public var recording: Workspace.Recording?
  public var agentStateDir: String?

  public init?(_ workspace: Workspace) {
    guard let tutorial = workspace.tutorial else { return nil }
    path = workspace.path
    version = tutorial.version
    phase = workspace.phase
    phaseSince = workspace.phaseSince.flatMap(parseTimestamp)
    live = workspace.live
    build = workspace.build
    builds = workspace.builds?.ios ?? []
    lastBuild = workspace.lastBuilds?.ios
    ios = workspace.ios
    errorsSinceMarker = workspace.logs?.errorsSinceMarker
    recording = workspace.recording
    agentStateDir = workspace.agentDevice?.stateDir
  }

  fileprivate var buildDates: [Date] {
    builds.compactMap { parseTimestamp($0.build.startedAt) }
      + [build?.startedDate, lastBuild.flatMap { parseTimestamp($0.startedAt) }].compactMap { $0 }
  }

  public static func select(_ workspaces: [Workspace], trackedPath: String?) -> Self? {
    let tours = workspaces.compactMap(Self.init)
    if let tracked = tours.first(where: { $0.path == trackedPath }) { return tracked }
    return tours.max {
      let lhs = $0.phaseSince ?? $0.buildDates.max() ?? .distantPast
      let rhs = $1.phaseSince ?? $1.buildDates.max() ?? .distantPast
      return lhs == rhs ? $0.path < $1.path : lhs < rhs
    }
  }
}

public enum TutorialViewerEvent: Equatable, Sendable {
  case opened(String)
  case input(String)
}

public struct TutorialRecord: Codable, Equatable, Sendable {
  public var version: Int
  public var tourPath: String?
  public var startedAt: Date
  public var step: String
  public var done: [String]
  public var skipped: [String]
  public var manual: Bool
  public var stepSince: Date?
  public var stepTimes: [String: Date]?
  public var refreshErrors: Int?
  public var stopped: Bool?
  public var restartAfter: Date?
  public var restartDisappeared: Bool?
  public var firstTitle: String?
  public var runPromptCopiedAt: Date?
  public var phonePairedAtStart: Bool?
  public var approvedMachine: String?
  fileprivate var refreshActionAt: Date?

  public init(
    version: Int, tourPath: String? = nil, startedAt: Date, step: String = "begin",
    done: [String] = [], skipped: [String] = [], manual: Bool = false
  ) {
    self.version = version
    self.tourPath = tourPath
    self.startedAt = startedAt
    self.step = step
    self.done = done
    self.skipped = skipped
    self.manual = manual
  }

  public func archivedProjectRoots(in archives: [ArchivedWorkspace]) -> [String] {
    guard let tourPath else { return [] }
    return archives.filter {
      $0.projectRoot == tourPath && parseTimestamp($0.removedAt).map { $0 > startedAt } == true
    }.map(\.projectRoot)
  }

  public func beginWaitTimedOut(now: Date) -> Bool {
    !manual && runPromptCopiedAt.map { now.timeIntervalSince($0) >= 180 } == true
  }
}

public final class TutorialRecordStore {
  private let defaults: UserDefaults
  private static let key = "tutorial.progress"

  public init(_ defaults: UserDefaults = .standard) { self.defaults = defaults }

  public var record: TutorialRecord? {
    get {
      defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(TutorialRecord.self, from: $0) }
    }
    set {
      if let newValue {
        defaults.set(try? JSONEncoder().encode(newValue), forKey: Self.key)
      } else {
        defaults.removeObject(forKey: Self.key)
      }
    }
  }
}

public struct TutorialInput: Sendable {
  public var environment: TutorialEnvironment?
  public var archivedProjectRoots: [String]
  public var logRecords: [LogRecord]
  public var viewerEvents: [TutorialViewerEvent]
  public var pairedPhoneCount: Int?
  public var machineApproved: Bool
  public var approvedMachine: String?
  public var replayOff: Bool
  public var archiveEnabled: Bool
  public var now: Date
  public var record: TutorialRecord?

  public init(
    environment: TutorialEnvironment?, archivedProjectRoots: [String] = [], logRecords: [LogRecord] = [],
    viewerEvents: [TutorialViewerEvent] = [], pairedPhoneCount: Int? = nil, machineApproved: Bool = false,
    approvedMachine: String? = nil, replayOff: Bool = false, archiveEnabled: Bool = true, now: Date, record: TutorialRecord? = nil
  ) {
    self.environment = environment
    self.archivedProjectRoots = archivedProjectRoots
    self.logRecords = logRecords
    self.viewerEvents = viewerEvents
    self.pairedPhoneCount = pairedPhoneCount
    self.machineApproved = machineApproved
    self.approvedMachine = approvedMachine
    self.replayOff = replayOff
    self.archiveEnabled = archiveEnabled
    self.now = now
    self.record = record
  }
}

public enum TutorialStepState: Equatable, Sendable {
  case pending, current, done, skipped
  case failed(String)
}

public struct TutorialTick: Equatable, Sendable {
  public var id: String
  public var done: Bool
  public var optional: Bool
}

public struct TutorialStepProgress: Equatable, Sendable {
  public var id: String
  public var state: TutorialStepState
  public var detail: String
  public var ticks: [TutorialTick]
  public var canMarkDone: Bool
}

public struct TutorialSnapshot: Sendable {
  public var steps: [TutorialStepProgress]
  public var currentStep: String?
  public var record: TutorialRecord
  public var shouldReopen: Bool
  public var isComplete: Bool { currentStep == nil }
}

public struct TutorialProgress: Sendable {
  public private(set) var record: TutorialRecord?
  private var viewerOpened = false
  private var viewerInput = false
  private var restartAfter: Date?
  private var details: [String: String] = [:]

  public init() {}

  public mutating func requestRestart(now: Date) {
    if record != nil {
      record?.restartAfter = now
      record?.restartDisappeared = nil
    } else {
      restartAfter = now
    }
  }

  public mutating func skip(now: Date) {
    guard var record, record.step != "done" else { return }
    record.skipped.append(record.step)
    self.record = record
    advance(now)
  }

  @discardableResult
  public mutating func markDone(now: Date) -> Bool {
    guard let record, record.step != "done", now.timeIntervalSince(record.stepSince ?? record.startedAt) >= 120 else {
      return false
    }
    complete(at: now)
    return true
  }

  public mutating func setManual(_ manual: Bool) { record?.manual = manual }

  public mutating func copiedRunPrompt(now: Date) {
    guard record?.step == "begin", record?.manual == false, record?.runPromptCopiedAt == nil else { return }
    record?.runPromptCopiedAt = now
  }

  /// The first call must carry a real status snapshot; it consumes launch-time resume detection.
  public mutating func update(_ input: TutorialInput) -> TutorialSnapshot {
    let launching = record == nil
    if launching { record = input.record }
    let environment = input.environment
    if record == nil {
      let started =
        environment?.phaseSince ?? (environment?.builds.last?.build.startedAt).flatMap(parseTimestamp)
        ?? environment?.build?.startedDate ?? input.now
      record = TutorialRecord(version: environment?.version ?? TutorialSteps.supportedVersions.max()!, startedAt: started)
    }
    if let restartAfter {
      record?.restartAfter = restartAfter
      self.restartAfter = nil
    }
    if record?.tourPath == nil, let environment {
      record?.tourPath = environment.path
      record?.version = environment.version
    }
    let tracked = environment.flatMap { $0.path == record?.tourPath ? $0 : nil }
    if let restartAfter = record?.restartAfter, input.now > restartAfter {
      if tracked == nil {
        record?.restartDisappeared = true
      } else if let tracked {
        let oldestBuild = tracked.buildDates.min()
        if record?.restartDisappeared == true || oldestBuild.map({ $0 > restartAfter }) == true {
          self = Self()
          let started = oldestBuild.flatMap { $0 > restartAfter ? $0 : nil } ?? input.now
          record = TutorialRecord(version: tracked.version, tourPath: tracked.path, startedAt: started)
        }
      }
    }
    if launching, record?.restartAfter == nil, let path = record?.tourPath, tracked == nil,
      input.archivedProjectRoots.contains(path) || (!input.archiveEnabled && record?.step == "finish")
    {
      let skipped = record!.skipped
      record?.done = TutorialSteps.all.map(\.id).filter { !skipped.contains($0) }
      record?.step = "done"
    } else if launching {
      let step = firstUnfinished
      record?.step = step
    }
    if record?.stepSince == nil {
      let started = record!.startedAt
      record?.stepSince = started
    }
    let currentID = record!.step
    let currentSince = record!.stepSince!
    if record?.stepTimes == nil { record?.stepTimes = [:] }
    record?.stepTimes?[currentID] = currentSince
    let logs = input.logRecords.filter { $0.date >= record!.startedAt }.sorted { $0.ts < $1.ts }
    if record?.firstTitle == nil { record?.firstTitle = logs.compactMap { Self.title($0.msg) }.first }
    if let udid = tracked?.ios?.udid {
      for event in input.viewerEvents {
        if event == .opened(udid) { viewerOpened = true }
        if event == .input(udid), viewerOpened { viewerInput = true }
      }
    }
    var failure: String?
    if let version = tracked?.version ?? record?.version, !TutorialSteps.supportedVersions.contains(version) {
      failure =
        version < TutorialSteps.supportedVersions.min()!
        ? "Restart the tutorial with the current Stim CLI" : "Update Stim Desktop to follow this tutorial"
    } else {
      while record!.step != "done" {
        let id = record!.step
        if id == "phone", record?.phonePairedAtStart == nil {
          record?.phonePairedAtStart = (input.pairedPhoneCount ?? 0) > 0
        }
        let since = record!.stepSince ?? record!.startedAt
        let checkpoint = checkpoint(id, since: since, environment: tracked, logs: logs, input: input)
        details[id] = checkpoint.detail
        if let reason = checkpoint.failure {
          failure = reason
          break
        }
        guard let completed = checkpoint.completed else { break }
        complete(at: completed)
        if record?.step == "refresh" { record?.refreshErrors = tracked?.errorsSinceMarker }
      }
    }
    if input.machineApproved, let machine = input.approvedMachine,
      record?.step == "machine" || record?.done.contains("machine") == true
    {
      record?.approvedMachine = machine
    }
    let current = record!.step == "done" ? nil : record!.step
    let steps = TutorialSteps.all.map { step in
      let state: TutorialStepState =
        record!.skipped.contains(step.id)
        ? .skipped
        : record!.done.contains(step.id)
          ? .done
          : current == step.id ? failure.map(TutorialStepState.failed) ?? .current : .pending
      let checkpoint = checkpoint(
        step.id, since: record!.stepTimes?[step.id] ?? record!.startedAt, environment: tracked, logs: logs, input: input)
      return TutorialStepProgress(
        id: step.id, state: state,
        detail: failure != nil && current == step.id ? failure! : details[step.id] ?? checkpoint.detail,
        ticks: checkpoint.ticks,
        canMarkDone: current == step.id && input.now.timeIntervalSince(record!.stepSince ?? record!.startedAt) >= 120)
    }
    return TutorialSnapshot(
      steps: steps, currentStep: current, record: record!,
      shouldReopen: launching && (tracked != nil || current == nil))
  }

  private var firstUnfinished: String {
    TutorialSteps.all.first { !record!.done.contains($0.id) && !record!.skipped.contains($0.id) }?.id ?? "done"
  }

  private mutating func complete(at date: Date) {
    let step = record!.step
    record?.done.append(step)
    advance(max(date, record!.stepSince ?? record!.startedAt))
  }

  private mutating func advance(_ date: Date) {
    let step = firstUnfinished
    record?.step = step
    record?.stepSince = date
    record?.stepTimes?[step] = date
  }

  private struct Checkpoint {
    var completed: Date?
    var failure: String?
    var detail = ""
    var ticks: [TutorialTick] = []
  }

  private mutating func checkpoint(
    _ id: String, since: Date, environment: TutorialEnvironment?, logs: [LogRecord], input: TutorialInput
  ) -> Checkpoint {
    let now = input.now
    let last = environment?.lastBuild
    let history = environment?.builds ?? []
    let udid = environment?.ios?.udid
    let actions = logs.filter {
      udid != nil && $0.src == "agent" && $0.event == "agent_action" && $0.deviceId == udid && $0.date >= since
    }
    func signal(_ substring: String) -> LogRecord? { logs.first { $0.msg.contains(substring) } }
    func tick(_ id: String, _ done: Bool, optional: Bool = false) -> TutorialTick {
      TutorialTick(id: id, done: done, optional: optional)
    }
    switch id {
    case "begin":
      let appeared = environment?.builds.isEmpty == false || environment?.build != nil ? record?.startedAt : now
      return Checkpoint(
        completed: environment == nil ? nil : appeared,
        detail: record?.beginWaitTimedOut(now: now) == true && environment == nil
          ? "No tutorial workspace yet. Ask your agent what failed" : "Waiting for the tutorial workspace")
    case "sidebar":
      let visible = ["warming", "ready", "live"].contains(environment?.phase ?? "")
      let buildDate = history.last.flatMap { parseTimestamp($0.build.startedAt) } ?? environment?.build?.startedDate
      let shown = now.timeIntervalSince(since) >= 3
      return Checkpoint(completed: visible && shown ? buildDate : nil, detail: "Workspace in sidebar")
    case "build", "rebuild":
      if let last, last.status == "failed", parseTimestamp(last.startedAt).map({ $0 >= since }) == true {
        return Checkpoint(
          failure: [last.cause?.key ?? last.errorCode ?? "Build failed", last.diagnostics?.first?.message]
            .compactMap { $0 }.joined(separator: ": "))
      }
      if id == "build", let last, last.status == "ok", parseTimestamp(last.startedAt).map({ $0 >= since }) == true {
        let first = history.reversed().first {
          $0.build.status == "ok" && parseTimestamp($0.build.startedAt).map { $0 >= since } == true
        }
        let build = first?.build ?? last
        return Checkpoint(
          completed: build.endedAt, detail: build.summary + (build.missReason.map { ": " + $0.summary } ?? ""),
          ticks: first?.finishedSteps.map { tick($0.phase, true) } ?? [])
      }
      if id == "rebuild", let latest = history.first, latest.build.status == "ok",
        let start = parseTimestamp(latest.build.startedAt), start >= since
      {
        return Checkpoint(
          completed: latest.build.endedAt,
          detail: latest.build.summary + (latest.build.missReason.map { ": " + $0.summary } ?? ""))
      }
      return Checkpoint(detail: id == "build" ? "Waiting for the iOS build" : "Run iOS again to see the cache outcome")
    case "device":
      guard environment?.ios?.app?.state == "running" else {
        return Checkpoint(failure: "Ask your agent to run the app again")
      }
      return Checkpoint(
        completed: viewerOpened && viewerInput ? now : nil, detail: "Open the live view, then tap Log an error.",
        ticks: [tick("opened", viewerOpened), tick("input", viewerInput)])
    case "logs":
      return Checkpoint(
        completed: signal("error-button")?.date, detail: "Find the tutorial records in Logs",
        ticks: [
          tick("error", signal("error-button") != nil), tick("crash", signal("crash-button") != nil, optional: true),
          tick("slow", signal("slow-request") != nil, optional: true),
        ])
    case "agent":
      let first = actions.first
      let errors = logs.filter { $0.msg.contains("error-button") }
      let source = errors.contains { $0.src == "device" } ? "device" : "metro"
      let errorTimes = Set(errors.filter { $0.src == source && $0.date >= since }.map(\.ts)).sorted()
      let replay =
        first.map { first in
          let afterAction = errorTimes.filter { $0 > first.ts }
          return afterAction.dropFirst().contains { ts in
            actions.contains { $0.ts > first.ts && $0.ts >= ts }
          }
        } ?? false
      let off = input.replayOff || environment?.recording?.enabled == false
      return Checkpoint(
        completed: first?.date, detail: off ? "Replay is off: Settings > Recording" : "Watch the agent actions",
        ticks: [tick("action", first != nil), tick("agent-replay", replay, optional: true)])
    case "refresh":
      if record?.step == "refresh" {
        let actionAt = actions.last?.date
        if record?.refreshErrors == nil || actionAt.map({ $0 > (record?.refreshActionAt ?? .distantPast) }) == true {
          record?.refreshErrors = environment?.errorsSinceMarker
          record?.refreshActionAt = actionAt
        }
      }
      let changed = logs.first { $0.date >= since && Self.title($0.msg).map { $0 != record?.firstTitle } == true }
      if record?.firstTitle != nil, let changed {
        return Checkpoint(completed: changed.date, detail: "Waiting for a changed title color")
      }
      if let baseline = record?.refreshErrors, let errors = environment?.errorsSinceMarker, errors > baseline {
        return Checkpoint(failure: "The edit introduced an error")
      }
      return Checkpoint(detail: "Waiting for a changed title color")
    case "phone":
      let paired = (input.pairedPhoneCount ?? 0) > 0
      return Checkpoint(
        completed: paired ? now : nil,
        detail: paired
          ? "Open Stim on your phone: the tour workspace is there"
          : input.pairedPhoneCount == nil ? "Turn on Serve to phones" : "Pair your phone")
    case "machine":
      let offloaded = last?.offloadedTo != nil && last.flatMap { parseTimestamp($0.startedAt) }.map { $0 >= since } == true
      return Checkpoint(
        completed: input.machineApproved ? now : nil, detail: "Choose an approved build machine",
        ticks: [
          tick("approved", input.machineApproved || record?.done.contains("machine") == true),
          tick("offloaded", offloaded, optional: true),
        ])
    case "finish":
      if record?.step == "finish", environment?.live == false { record?.stopped = true }
      let absent = environment == nil && record?.tourPath != nil
      let archived = record?.tourPath.map { input.archivedProjectRoots.contains($0) } == true
      let complete = absent && (!input.archiveEnabled || archived)
      return Checkpoint(
        completed: complete ? now : nil,
        detail: !input.archiveEnabled
          ? "Archived is off"
          : absent && !complete ? "Tutorial workspace gone: Restart" : "Stop the tutorial, then remove its worktree",
        ticks: [tick("stopped", record?.stopped == true), tick("archived", absent && archived)])
    default: return Checkpoint()
    }
  }

  private static func title(_ message: String) -> String? {
    guard let range = message.range(of: "title color=") else { return nil }
    return message[range.upperBound...].split(whereSeparator: { $0.isWhitespace || $0 == "]" }).first.map(String.init)
  }
}
