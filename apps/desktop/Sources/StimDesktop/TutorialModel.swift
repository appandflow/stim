import Combine
import Foundation
import StimKit

@MainActor
final class TutorialModel: ObservableObject {
  @Published private(set) var snapshot: TutorialSnapshot?
  @Published private(set) var isOpen = false
  @Published private(set) var cliFailure: String?
  @Published private(set) var workspace: Workspace?
  @Published private(set) var archiveEnabled: Bool?
  private var progress = TutorialProgress()
  private let records: TutorialRecordStore
  private let defaults: UserDefaults
  private var workspaces: [Workspace] = []
  private var archived: [ArchivedWorkspace] = []
  private var statusLoaded = false
  private var launchPending = true
  private var openPending = false
  private var logs: [LogRecord] = []
  private var now = Date()
  private var viewerEvents: [TutorialViewerEvents.Entry] = []
  private var viewerEventSequence = 0
  @Published private(set) var phoneState = TutorialPhoneState(pairedPhoneCount: nil)
  private var pairedPhoneCount: Int?
  private var removalRefused = false
  private var missingSince: Date?
  private var followedPath: String?
  private var followTask: Task<Void, Never>?
  private var cli: Task<StimCLI, Never>?
  private lazy var follower = LogFollower { [weak self] in self?.receive($0) }
  private lazy var agentFollower = LogFollower { [weak self] in self?.receive($0) }
  private static let seenKey = "tutorial.openedPaths"

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    records = TutorialRecordStore(defaults)
  }

  var tourPath: String? { snapshot?.record.tourPath ?? records.record?.tourPath }

  func ask(for step: TutorialStep) -> String? {
    var template = step.ask
    if step.id == snapshot?.currentStep, step.id == "build",
      snapshot?.steps.first(where: { $0.id == step.id }).map({
        if case .failed = $0.state { return $0.action == nil }
        return false
      }) == true
    {
      template = TutorialSteps.retryAsk
    }
    let existing = Set(workspaces.map(\.path))
    return template.map {
      tutorialAsk(
        $0, tourPath: tourPath, repository: workspace?.worktree?.repository, second: snapshot?.record.secondPath,
        existing: existing)
    }
  }

  var notice: TutorialNotice? {
    if let cliFailure { return TutorialNotice(cliFailure, action: .updateCLI) }
    if let notice = workspace?.tutorial.flatMap({ TutorialNotice.version($0.version) }) { return notice }
    if snapshot?.currentStep == "begin" {
      return snapshot?.record.beginWaitTimedOut(now: now) == true
        ? TutorialNotice("No tutorial workspace yet. Ask your agent what failed", action: .restart)
        : TutorialNotice("Waiting for the tutorial workspace...")
    }
    if workspace == nil, tourPath != nil, snapshot?.isComplete == false,
      !workspaces.contains(where: { $0.path == snapshot?.record.secondPath })
    {
      return TutorialNotice("Tutorial workspace gone: Restart", action: .restart)
    }
    if snapshot?.currentStep == "finish", removalRefused {
      return TutorialNotice("Removal was refused: revert the tutorial edit and try again")
    }
    return nil
  }

  func configure(cli: Task<StimCLI, Never>) {
    self.cli = cli
    followedPath = nil
    syncFollowers()
    if isOpen { checkCLI() }
  }

  func update(
    workspaces: [Workspace], archived: [ArchivedWorkspace], sheetOpen: Bool, now: Date = Date(),
    viewerEvents: [TutorialViewerEvents.Entry] = [], pairedPhoneCount: Int? = nil, removalRefused: Bool = false
  ) {
    self.now = now
    if let stored = progress.record ?? records.record, !TutorialSteps.supportedVersions.contains(stored.version) {
      progress = TutorialProgress()
      records.record = nil
      snapshot = nil
      archiveEnabled = nil
      logs = []
      viewerEventSequence = viewerEvents.last?.sequence ?? 0
      launchPending = false
    }
    self.viewerEvents = viewerEvents
    self.pairedPhoneCount = pairedPhoneCount
    phoneState = TutorialPhoneState(pairedPhoneCount: pairedPhoneCount)
    self.removalRefused = removalRefused
    self.workspaces = workspaces
    self.archived = archived
    statusLoaded = true
    let saved = progress.record ?? records.record
    let archivedRoots = saved?.archivedProjectRoots(in: archived) ?? []
    let candidate = TutorialEnvironment.select(
      workspaces, trackedPath: saved?.tourPath, since: saved.flatMap { $0.tourPath == nil ? $0.startedAt : nil },
      repository: saved?.clonePath)
    let tracked = saved?.tourPath
    workspace = workspaces.first { $0.path == (tracked ?? candidate?.path) }
    let seen = defaults.stringArray(forKey: Self.seenKey) ?? []
    if launchPending, let saved {
      if let path = saved.tourPath, workspace != nil || archivedRoots.contains(path) {
        openPending = saved.step != "done"
        launchPending = false
      } else if saved.tourPath == nil, saved.step != "done" {
        openPending = true
        launchPending = false
      }
    } else if let candidate, !seen.contains(candidate.path), saved == nil || saved?.step == "done" {
      progress = TutorialProgress()
      snapshot = nil
      archiveEnabled = nil
      logs = []
      viewerEventSequence = viewerEvents.last?.sequence ?? 0
      records.record = nil
      workspace = workspaces.first { $0.path == candidate.path }
      openPending = true
      launchPending = false
    }
    if openPending, !sheetOpen {
      let opening = !isOpen
      isOpen = true
      openPending = false
      if opening { checkCLI() }
    }
    guard isOpen || progress.record != nil || records.record != nil else { return }
    if workspace == nil, tourPath != nil {
      if missingSince == nil { missingSince = now }
    } else {
      missingSince = nil
    }
    let fallback =
      archiveEnabled == nil && progress.record?.step == "finish" && progress.record?.stopped == true
      && missingSince.map { now.timeIntervalSince($0) >= 10 } == true
    snapshot = progress.update(
      TutorialInput(
        environment: workspace.flatMap(TutorialEnvironment.init), siblings: workspaces.compactMap(TutorialEnvironment.init),
        archivedProjectRoots: archivedRoots,
        logRecords: logs, viewerEvents: viewerEvents.filter { $0.sequence > viewerEventSequence }.map(\.event),
        pairedPhoneCount: pairedPhoneCount, phoneApp: FeatureFlags.isEnabled(.phoneApp, defaults: defaults),
        replayOff: workspace?.replayOff ?? false,
        archiveEnabled: fallback ? false : archiveEnabled ?? true,
        now: now, record: records.record))
    if records.record != snapshot?.record { records.record = snapshot?.record }
    if let path = tourPath, isOpen, !seen.contains(path) { defaults.set(seen + [path], forKey: Self.seenKey) }
    syncFollowers()
  }

  func open(beginning: Bool = false, now: Date = Date()) {
    if beginning {
      progress = TutorialProgress()
      records.record = TutorialRecord(version: TutorialSteps.supportedVersions.max()!, startedAt: now)
      snapshot = nil
      workspace = nil
      logs = []
      viewerEventSequence = viewerEvents.last?.sequence ?? 0
    }
    isOpen = true
    launchPending = false
    refresh(now: now)
    syncFollowers()
    checkCLI()
  }

  func close() {
    isOpen = false
    openPending = false
    syncFollowers()
  }

  func skip() {
    progress.skip(now: Date())
    refresh()
  }
  func markDone() {
    progress.markDone(now: Date())
    refresh()
  }
  func copiedPrompt(now: Date = Date()) {
    progress.copiedRunPrompt(now: now)
    refresh(now: now)
  }

  func commands(for step: TutorialStep) -> String {
    tutorialCommands(
      step.commands, tourPath: tourPath, repository: workspace?.worktree?.repository,
      stateDir: workspace?.agentDevice?.stateDir,
      udid: workspace?.ios?.udid, second: snapshot?.record.secondPath)
  }

  private func refresh(now: Date = Date()) {
    guard statusLoaded else { return }
    update(
      workspaces: workspaces, archived: archived, sheetOpen: false, now: now,
      viewerEvents: viewerEvents, pairedPhoneCount: pairedPhoneCount, removalRefused: removalRefused)
  }

  private func syncFollowers() {
    let path = isOpen && workspace?.live == true ? workspace?.path : nil
    guard path != followedPath else { return }
    followTask?.cancel()
    follower.stop()
    agentFollower.stop()
    followedPath = path
    guard let path, let cli else { return }
    followTask = Task {
      let cli = await cli.value
      guard !Task.isCancelled, followedPath == path else { return }
      var query = LogQuery()
      query.search = "\\[stim:tutorial\\]"
      follower.start(query, cli: cli, cwd: path)
      query.search = ""
      query.sources = [.agent]
      agentFollower.start(query, cli: cli, cwd: path)
      let settings = try? await cli.settings(cwd: path)
      guard !Task.isCancelled, followedPath == path else { return }
      if let value = settings?.entry("archive.enabled")?.value {
        switch value {
        case .bool(let enabled): archiveEnabled = enabled
        case .string(let enabled): archiveEnabled = ["true", "1"].contains(enabled)
        default: break
        }
      }
      refresh()
    }
  }

  private func receive(_ event: LogFollower.Event) {
    guard case .records(let batch) = event else { return }
    struct Key: Hashable {
      var ts: Double
      var src: String
      var msg: String
      init(_ record: LogRecord) {
        ts = record.ts
        src = record.src
        msg = record.msg
      }
    }
    var seen = Set(logs.map(Key.init))
    logs = Array((logs + batch.filter { seen.insert(Key($0)).inserted }).suffix(10000))
    refresh()
  }

  private func checkCLI() {
    guard let cli else { return }
    Task {
      let cli = await cli.value
      guard await cli.versionOutput() != nil else {
        cliFailure = "Update the Stim CLI to run the tutorial"
        return
      }
      do {
        try await cli.tutorialGuide()
        cliFailure = nil
      } catch { cliFailure = "Update the Stim CLI to run the tutorial" }
    }
  }
}
