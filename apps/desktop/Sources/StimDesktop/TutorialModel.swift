import Combine
import Foundation
import StimKit

@MainActor
final class TutorialModel: ObservableObject {
  @Published private(set) var snapshot: TutorialSnapshot?
  @Published private(set) var isOpen = false
  @Published private(set) var restarting = false
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
  private var viewerEvents: [TutorialViewerEvent] = []
  private var viewerEventOffset = 0
  private var pairedPhoneCount: Int?
  private var removalRefused = false
  private var missingSince: Date?
  private var followedPath: String?
  private var followTask: Task<Void, Never>?
  private var cli: Task<StimCLI, Never>?
  private lazy var follower = LogFollower { [weak self] in self?.receive($0) }
  private lazy var agentFollower = LogFollower { [weak self] in self?.receive($0) }
  private static let seenKey = "tutorial.openedPaths"
  private static let machineKey = "tutorial.machine"

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    records = TutorialRecordStore(defaults)
  }

  var tourPath: String? { snapshot?.record.tourPath ?? records.record?.tourPath }
  var manual: Bool { snapshot?.record.manual == true }
  var prompt: String? {
    if restarting { return TutorialSteps.restartPrompt }
    if let step = snapshot?.currentStep,
      ["build", "device"].contains(step),
      snapshot?.steps.first(where: { $0.id == step }).map({
        if case .failed = $0.state { return true }
        return false
      }) == true
    {
      return "Continue the Stim tutorial: run"
    }
    return TutorialSteps.all.first { $0.id == snapshot?.currentStep }?.prompt
  }

  var message: String? {
    if let cliFailure { return cliFailure }
    if restarting { return "Waiting for a restarted tutorial workspace..." }
    if let version = workspace?.tutorial?.version, !TutorialSteps.supportedVersions.contains(version) {
      return "Update Stim Desktop to follow this tutorial"
    }
    if snapshot?.currentStep == "begin" {
      return snapshot?.record.beginWaitTimedOut(now: now) == true
        ? "No tutorial workspace yet. Ask your agent what failed" : "Waiting for the tutorial workspace..."
    }
    if workspace == nil, tourPath != nil, snapshot?.isComplete == false {
      return "Tutorial workspace gone: Restart"
    }
    if snapshot?.currentStep == "finish", removalRefused {
      return "Your agent reported a refusal: ask it to revert the tutorial edit"
    }
    if snapshot?.currentStep == "finish",
      workspace?.issues?.contains(where: {
        $0.message.localizedCaseInsensitiveContains("refus")
          || $0.message.localizedCaseInsensitiveContains("dirty")
          || $0.message.localizedCaseInsensitiveContains("unpushed")
      }) == true
    {
      return "Your agent reported a refusal: ask it to revert the tutorial edit"
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
    viewerEvents: [TutorialViewerEvent] = [], pairedPhoneCount: Int? = nil, removalRefused: Bool = false
  ) {
    self.now = now
    self.viewerEvents = viewerEvents
    if viewerEvents.count < viewerEventOffset { viewerEventOffset = 0 }
    self.pairedPhoneCount = pairedPhoneCount
    self.removalRefused = removalRefused
    self.workspaces = workspaces
    self.archived = archived
    statusLoaded = true
    let saved = progress.record ?? records.record
    let archivedRoots = saved?.archivedProjectRoots(in: archived) ?? []
    let candidate = TutorialEnvironment.select(workspaces, trackedPath: saved?.tourPath)
    let tracked = saved?.tourPath
    workspace =
      workspaces.first { $0.path == (tracked ?? candidate?.path) }
      ?? (restarting ? workspaces.first { $0.path == candidate?.path } : nil)
    let seen = defaults.stringArray(forKey: Self.seenKey) ?? []
    if launchPending, let saved {
      if let path = saved.tourPath, workspace != nil || archivedRoots.contains(path) {
        openPending = saved.step != "done"
        launchPending = false
      }
    } else if let candidate, !seen.contains(candidate.path), saved == nil || saved?.step == "done" {
      progress = TutorialProgress()
      snapshot = nil
      archiveEnabled = nil
      logs = []
      viewerEventOffset = viewerEvents.count
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
    let oldStart = progress.record?.startedAt
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
        environment: workspace.flatMap(TutorialEnvironment.init), archivedProjectRoots: archivedRoots,
        logRecords: logs, viewerEvents: Array(viewerEvents.dropFirst(viewerEventOffset)), pairedPhoneCount: pairedPhoneCount,
        replayOff: workspace?.replayOff ?? false, archiveEnabled: fallback ? false : archiveEnabled ?? true,
        now: now, record: records.record))
    if restarting, oldStart != snapshot?.record.startedAt {
      restarting = false
      logs = []
    }
    if records.record != snapshot?.record { records.record = snapshot?.record }
    if let path = tourPath, isOpen, !seen.contains(path) { defaults.set(seen + [path], forKey: Self.seenKey) }
    syncFollowers()
  }

  func open(beginning: Bool = false) {
    if beginning {
      progress = TutorialProgress()
      records.record = nil
      snapshot = nil
      workspace = nil
      logs = []
      viewerEventOffset = viewerEvents.count
      restarting = false
    }
    isOpen = true
    launchPending = false
    refresh()
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
  func setManual(_ manual: Bool) {
    progress.setManual(manual)
    refresh()
  }
  func copiedPrompt(now: Date = Date()) {
    guard !restarting else { return }
    progress.copiedRunPrompt(now: now)
    refresh(now: now)
  }

  func restart(now: Date = Date()) {
    viewerEvents = []
    viewerEventOffset = 0
    TutorialViewerEvents.shared.reset()
    progress.requestRestart(now: now)
    restarting = true
    isOpen = true
  }

  func commands(for step: TutorialStep) -> String {
    tutorialCommands(
      step.manual, tourPath: tourPath, repository: workspace?.worktree?.repository,
      stateDir: workspace?.agentDevice?.stateDir, machine: defaults.string(forKey: Self.machineKey))
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
    logs = Array((logs + batch).suffix(10000))
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
        _ = try await cli.tutorialGuide()
        cliFailure = nil
      } catch { cliFailure = "Update the Stim CLI to run the tutorial" }
    }
  }
}
