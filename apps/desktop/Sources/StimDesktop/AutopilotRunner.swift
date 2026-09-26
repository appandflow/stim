import AppKit
import StimKit

/// Runs Stim's cleanup commands on a schedule while the app runs: `stim gc --idle` for idle devices,
/// a nightly `stim gc --delete` bounded by age, and an unbounded `stim gc --delete` when free disk falls under
/// the Stim budget. It also removes worktrees whose pull request was merged or closed, when `stim gc` finds them safe.
/// Every run goes through the CLI on the machine action slot, so it never overlaps a cleanup the user
/// started, and is recorded in the activity log.
@MainActor
final class AutopilotRunner: ObservableObject {
  static let tick: TimeInterval = 60
  static let idleRetry: TimeInterval = 10 * 60
  static let pressureRetry: TimeInterval = 60 * 60
  static let budgetMaxAge: TimeInterval = 30 * 60
  static let reportMaxAge: TimeInterval = 10 * 60

  @Published private(set) var log: [AutopilotLogEntry]
  /// Set while free disk is under the Stim budget.
  @Published private(set) var pressure: PressurePlan?
  /// The volume Stim writes to with the least free space, measured on every check.
  @Published private(set) var lowestVolume: DiskVolume?
  /// Worktrees whose pull request was merged or closed that `stim gc` keeps, with the reason.
  @Published private(set) var finishedPullRequests: [PullRequestCleanup.Flag] = []
  /// Why the last pull request check could not ask GitHub, or nil when it could.
  @Published private(set) var pullRequestCheck: String?

  private let status: StatusStore
  private let actions: ActionCenter
  private let cli: Task<StimCLI, Never>
  private var timer: Timer?
  private var checking = false
  private var lastIdleRun: Date?
  private var lastPressureRun: Date?
  private(set) var budget: (minFree: Double, hardFloor: Double)?
  private var budgetAt: Date?
  private var report: GcReport?
  private var reportAt: Date?
  private var notifiedEpisode = false
  private var nightlyHour: Int?
  private var pollingPullRequests = false
  private var lastPullRequestPoll: Date?
  private var pullRequestVerdict: (candidates: Set<String>, at: Date, nextEligible: Date?)?
  private var activation: NSObjectProtocol?

  init(status: StatusStore, actions: ActionCenter, cli: Task<StimCLI, Never>) {
    self.status = status
    self.actions = actions
    self.cli = cli
    log = AutopilotLog.decode(UserDefaults.standard.data(forKey: AppPreferences.Key.autopilotLog))
  }

  private var defaults: UserDefaults { .standard }

  func start() {
    guard timer == nil else { return }
    if defaults.object(forKey: AppPreferences.Key.autopilotLastNightly) == nil {
      defaults.set(Date(), forKey: AppPreferences.Key.autopilotLastNightly)
    }
    NotificationResponder.shared.runPlan = { [weak self] in self?.runPlanFromNotification() }
    if defaults.bool(forKey: AppPreferences.Key.notifiesDiskPressure)
      || defaults.bool(forKey: AppPreferences.Key.notifiesWorktreeRemoval)
    {
      Notifier.requestAuthorization()
    }
    timer = Timer.scheduledTimer(withTimeInterval: Self.tick, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.check() }
    }
    Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.check() }
    }
    activation = NotificationCenter.default.addObserver(
      forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.checkPullRequests(interval: PullRequestCleanup.focusInterval) }
    }
  }

  func clearLog() {
    log = []
    defaults.removeObject(forKey: AppPreferences.Key.autopilotLog)
  }

  /// The Do it of a pressure notification, which can be clicked long after it was posted: it runs the plan
  /// only while disk is still under the budget, and otherwise opens the Machine page.
  func runPlanFromNotification() {
    NSApp.activate(ignoringOtherApps: true)
    guard let plan = pressure, !plan.isEmpty else {
      OpenRequests.shared.showsMachine = true
      return
    }
    runPressurePlan(trigger: .manual, present: true)
  }

  func runPressurePlan(trigger: AutopilotLogEntry.Trigger, present: Bool) {
    lastPressureRun = Date()
    run(trigger, "Reclaim disk space", PressurePlan.arguments, present: present) { run in
      guard trigger == .pressure else { return }
      Notifier.postPressure(
        id: "pressure-ran-\(run.id)", title: "Free disk is under the Stim budget",
        body: "Stim Desktop ran stim gc --delete. \(run.exitStatus == 0 ? "It finished" : "It exited with an error"); see the autopilot log.",
        offersPlan: false)
    }
  }

  private func check() {
    checkPullRequests(interval: PullRequestCleanup.pollInterval)
    let now = Date()
    let idle = actions.active(for: ActionCenter.machineKey) == nil
    let hour = defaults.integer(forKey: AppPreferences.Key.autopilotNightlyHour)
    if !defaults.bool(forKey: AppPreferences.Key.autopilotNightly) || (nightlyHour != nil && nightlyHour != hour) {
      defaults.set(now, forKey: AppPreferences.Key.autopilotLastNightly)
    }
    nightlyHour = hour
    if idle, defaults.bool(forKey: AppPreferences.Key.autopilotNightly),
      let last = defaults.object(forKey: AppPreferences.Key.autopilotLastNightly) as? Date,
      AutopilotSchedule.nightlyDue(now: now, hour: hour, lastRun: last)
    {
      defaults.set(now, forKey: AppPreferences.Key.autopilotLastNightly)
      let days = defaults.integer(forKey: AppPreferences.Key.autopilotNightlyOlderThanDays)
      run(.nightly, "Nightly cleanup", AutopilotSchedule.nightlyArguments(olderThanDays: days), present: false)
      return
    }
    let minutes = defaults.integer(forKey: AppPreferences.Key.autopilotIdleMinutes)
    if idle, defaults.bool(forKey: AppPreferences.Key.autopilotIdleShutdown), minutes > 0,
      lastIdleRun.map({ now.timeIntervalSince($0) >= Self.idleRetry }) ?? true,
      AutopilotSchedule.idleShutdownDue(bootedDevices, minutes: minutes, now: now)
    {
      lastIdleRun = now
      run(.idle, "Shut down idle devices", ["gc", "--idle", AutopilotSchedule.idleDuration(minutes: minutes), "--json"], present: false)
      return
    }
    checkPressure()
  }

  /// Booted devices of workspaces with no build running, which `gc --idle` skips.
  private var bootedDevices: [AutopilotSchedule.Device] {
    (status.payload?.environments ?? []).filter { $0.build?.isRunning != true }.flatMap { env in
      env.devices.filter(\.isRunning)
    }
    .map {
      AutopilotSchedule.Device(activity: $0.activity, screenChangedAt: $0.activityKey.flatMap(ScreenActivity.shared.lastChange))
    }
  }

  private func checkPressure() {
    guard !checking else { return }
    checking = true
    let now = Date()
    let locations = stimDiskLocations(status.payload?.environments ?? [], status: status)
    let budget = budgetAt.map { now.timeIntervalSince($0) < Self.budgetMaxAge } == true ? self.budget : nil
    let report = reportAt.map { now.timeIntervalSince($0) < Self.reportMaxAge } == true ? self.report : nil
    let cli = cli
    Task.detached(priority: .utility) {
      let cli = await cli.value
      let volumes = DiskUsage.volumes(for: locations)
      let lowest = volumes.min { $0.freeBytes < $1.freeBytes }
      let free = lowest?.freeBytes
      let limits =
        budget
        ?? (try? cli.settings(cwd: NSHomeDirectory())).map { settings in
          (
            minFree: settings.entry("budget.minFreeDiskGb")?.number ?? 0,
            hardFloor: settings.entry("budget.hardFloorDiskGb")?.number ?? 0
          )
        }
      var plan = free.flatMap { free in
        limits.flatMap { PressurePlan.make(freeBytes: free, minimumFreeGb: $0.minFree, hardFloorGb: $0.hardFloor, report: nil) }
      }
      var fresh = report
      if plan != nil, fresh == nil { fresh = try? cli.gcReport() }
      let known = free != nil && limits != nil && (plan == nil || fresh != nil)
      if let free, let limits, plan != nil, fresh != nil {
        plan = PressurePlan.make(freeBytes: free, minimumFreeGb: limits.minFree, hardFloorGb: limits.hardFloor, report: fresh)
      }
      let result = plan
      let checkedReport = fresh
      await MainActor.run {
        self.checking = false
        self.lowestVolume = lowest
        if budget == nil, let limits {
          self.budget = limits
          self.budgetAt = now
        }
        if report == nil, let checkedReport {
          self.report = checkedReport
          self.reportAt = now
        }
        guard known else { return }
        self.pressure = result
        self.react(to: result)
      }
    }
  }

  private func react(to plan: PressurePlan?) {
    guard let plan else {
      if notifiedEpisode { Notifier.removeDeliveredPressure() }
      notifiedEpisode = false
      return
    }
    let acts = defaults.bool(forKey: AppPreferences.Key.autopilotPressure)
    if acts, !plan.isEmpty, actions.active(for: ActionCenter.machineKey) == nil,
      lastPressureRun.map({ Date().timeIntervalSince($0) >= Self.pressureRetry }) ?? true
    {
      runPressurePlan(trigger: .pressure, present: false)
      return
    }
    guard !notifiedEpisode, !(acts && !plan.isEmpty) else { return }
    notifiedEpisode = true
    Notifier.postPressure(
      id: "pressure-\(Date().timeIntervalSince1970)", title: plan.headline, body: plan.proposal, offersPlan: !plan.isEmpty)
  }

  private func run(
    _ trigger: AutopilotLogEntry.Trigger, _ title: String, _ arguments: [String], present: Bool,
    completion: ((ActionRun) -> Void)? = nil
  ) {
    let command = StimCommand(arguments, cwd: NSHomeDirectory())
    actions.run(title, steps: [command], key: ActionCenter.machineKey, present: present) { [weak self] run in
      guard let self else { return }
      self.reportAt = nil
      self.checkPressure()
      self.record(
        AutopilotLogEntry(
          date: Date(), trigger: trigger, command: "stim \(arguments.joined(separator: " "))",
          exitStatus: run.launchError == nil ? run.exitStatus : nil, note: run.summary))
      completion?(run)
    }
  }

  /// Lists the merged and closed pull requests of each repository with a Stim environment, one `gh` call each.
  /// Only when a linked worktree's branch is among them does it ask `stim gc --json`, and it asks again only when
  /// those worktrees change, one becomes eligible, or the last answer is `reportMaxAge` old.
  private func checkPullRequests(interval: TimeInterval) {
    guard defaults.bool(forKey: AppPreferences.Key.autopilotPullRequests), !pollingPullRequests else { return }
    let now = Date()
    if let last = lastPullRequestPoll, now.timeIntervalSince(last) < interval { return }
    guard let environments = status.payload?.environments else { return }
    lastPullRequestPoll = now
    pollingPullRequests = true
    let repositories = Set(environments.compactMap { $0.worktree?.repository })
    let previous = pullRequestVerdict
    let cli = cli
    Task.detached(priority: .utility) {
      let cli = await cli.value
      let gh = GitHubCLI(environment: cli.environment)
      var finished: [String: Set<String>] = [:]
      for repository in repositories {
        if let branches = gh.run(PullRequestCleanup.listArguments, cwd: repository).flatMap(PullRequestCleanup.branches) {
          finished[repository] = branches
        }
      }
      let problem = PullRequestCleanup.problem(
        hasGitHubCLI: gh.executable != nil, repositories: repositories.count, answered: finished.count)
      let candidates = PullRequestCleanup.candidates(environments, finished: finished)
      let stale =
        previous.map {
          $0.candidates != candidates || now.timeIntervalSince($0.at) >= PullRequestCleanup.reportMaxAge
            || $0.nextEligible.map { now >= $0 } == true
        } ?? true
      let answered = finished
      let asked = !candidates.isEmpty && stale
      let report = asked ? try? cli.gcReport() : nil
      await MainActor.run {
        self.pollingPullRequests = false
        self.pullRequestCheck = problem
        if candidates.isEmpty, problem == nil {
          self.pullRequestVerdict = nil
          self.finishedPullRequests = []
          return
        }
        guard asked else { return }
        self.pullRequestVerdict = (candidates, now, report.flatMap(PullRequestCleanup.nextEligible))
        guard let report else { return }
        self.finishedPullRequests = PullRequestCleanup.flagged(report)
        self.removeFinished(
          PullRequestCleanup.stillRemovable(
            PullRequestCleanup.removable(report), environments: self.status.payload?.environments ?? [],
            finished: answered))
      }
    }
  }

  /// `stim worktree remove` on each worktree, which re-checks it under its own locks before removing it.
  private func removeFinished(_ worktrees: [GcReport.LinkedWorktree]) {
    guard !worktrees.isEmpty else { return }
    let steps = worktrees.map { StimCommand(["worktree", "remove", $0.path], cwd: NSHomeDirectory()) }
    let started = actions.run(
      "Remove worktrees of finished pull requests", steps: steps, key: ActionCenter.machineKey, present: false
    ) { [weak self] run in
      guard let self else { return }
      self.pullRequestVerdict = nil
      let removed = worktrees.filter { !FileManager.default.fileExists(atPath: $0.path) }
      let kept = worktrees.count - removed.count
      var note = removed.isEmpty ? nil : PullRequestCleanup.summary(removed)
      if kept > 0 { note = [note, "kept \(kept); \(run.summary ?? "see the activity log")"].compactMap { $0 }.joined(separator: "; ") }
      self.record(
        AutopilotLogEntry(
          date: Date(), trigger: .pullRequests,
          command: steps.map { "stim \($0.arguments.joined(separator: " "))" }.joined(separator: "; "),
          exitStatus: run.launchError == nil ? run.exitStatus : nil, note: note))
      if !removed.isEmpty {
        Notifier.postWorktreesRemoved(
          title: PullRequestCleanup.summary(removed),
          body: removed.map { self.status.names(ofPath: $0.path).title }.joined(separator: ", "))
      }
    }
    if started == nil { pullRequestVerdict = nil }
  }

  private func record(_ entry: AutopilotLogEntry) {
    log = AutopilotLog.appending(entry, to: log)
    defaults.set(AutopilotLog.encode(log), forKey: AppPreferences.Key.autopilotLog)
  }
}
