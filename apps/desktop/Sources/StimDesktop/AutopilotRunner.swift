import AppKit
import Combine
import StimKit
import StimStores

/// Runs Stim's cleanup commands on a schedule while the app runs: `stim gc --idle` for idle devices,
/// a nightly `stim gc --delete` bounded by age, and an unbounded `stim gc --delete` when free disk falls under
/// the Stim budget.
/// When the CLI's own automatic maintenance is on (`MaintenanceStatus.cleansAutomatically`), the CLI clears build
/// outputs, trims caches and removes finished worktrees, so the disk-pressure run stands down; idle shutdown and the
/// nightly run stay, because the CLI does not do them. When the CLI's last pass was blocked and disk is still under
/// the budget, the app asks with a notification instead of running `stim gc --delete`, which would clear what the
/// CLI keeps.
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
  /// The CLI's automatic maintenance as the last `stim status --json` reported it; nil from a `stim` without it.
  @Published private(set) var cliMaintenance: MaintenanceStatus?

  private let status: StatusStore
  private let actions: ActionCenter
  private let gc: GcReportStore
  private let disks: DiskVolumeStore
  private let settings: MachineSettingsStore
  private var timer: Timer?
  private var checking = false
  private var lastIdleRun: Date?
  private var lastPressureRun: Date?
  private(set) var budget: (minFree: Double, hardFloor: Double)?
  private var budgetAt: Date?
  private var notifiedEpisode = false
  private var nightlyHour: Int?
  private var maintenanceSubscription: AnyCancellable?

  init(
    status: StatusStore, actions: ActionCenter, gc: GcReportStore, disks: DiskVolumeStore, settings: MachineSettingsStore
  ) {
    self.status = status
    self.actions = actions
    self.gc = gc
    self.disks = disks
    self.settings = settings
    log = AutopilotLog.decode(UserDefaults.standard.data(forKey: AppPreferences.Key.autopilotLog))
    maintenanceSubscription = status.$payload.map { $0?.maintenance }.removeDuplicates().sink { [weak self] in
      self?.cliMaintenance = $0
    }
  }

  private var cliCleansAutomatically: Bool { cliMaintenance?.cleansAutomatically == true }

  private var defaults: UserDefaults { .standard }

  func start() {
    guard timer == nil else { return }
    if defaults.object(forKey: AppPreferences.Key.autopilotLastNightly) == nil {
      defaults.set(Date(), forKey: AppPreferences.Key.autopilotLastNightly)
    }
    NotificationResponder.shared.runPlan = { [weak self] in self?.runPlanFromNotification() }
    if defaults.bool(forKey: AppPreferences.Key.notifiesDiskPressure) {
      Notifier.requestAuthorization()
    }
    timer = Timer.scheduledTimer(withTimeInterval: Self.tick, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.check() }
    }
    Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.check() }
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
    run(trigger, "Reclaim disk space", PressurePlan.arguments, present: present) { run, summary in
      guard trigger == .pressure else { return }
      let archived = run.gcOutcome.flatMap { try? $0.get().archivedWorktrees.isEmpty } == false
      Notifier.postPressure(
        id: "\(archived ? Notifier.archivedPressurePrefix : Notifier.ranPressurePrefix)\(run.id)",
        title: "Free disk is under the Stim budget",
        body: summary
          ?? "Stim Desktop ran stim gc --delete. \(run.exitStatus == 0 ? "It finished" : "It exited with an error"); see the autopilot log.",
        offersPlan: false)
    }
  }

  private func check() {
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
      run(
        .idle, "Shut down idle devices", ["gc", "--idle", AutopilotSchedule.idleDuration(minutes: minutes), "--json"],
        present: false)
      return
    }
    checkPressure(maxAge: Self.tick / 2)
  }

  /// Booted devices of workspaces with no build running, which `gc --idle` skips.
  private var bootedDevices: [AutopilotSchedule.Device] {
    (status.payload?.environments ?? []).filter { $0.build?.isRunning != true }.flatMap { env in
      env.devices.filter { $0.isRunning && $0.platform != "macos" }
    }
    .map {
      AutopilotSchedule.Device(activity: $0.activity, screenChangedAt: $0.activityKey.flatMap(ScreenActivity.shared.lastChange))
    }
  }

  private func checkPressure(maxAge: TimeInterval) {
    guard !checking else { return }
    checking = true
    let now = Date()
    let disks = disks
    let budget = budgetAt.map { now.timeIntervalSince($0) < Self.budgetMaxAge } == true ? self.budget : nil
    let gc = gc
    let machineSettings = settings
    Task.detached(priority: .utility) {
      let volumes = await disks.volumes(maxAge: maxAge)
      let lowest = volumes.min { $0.freeBytes < $1.freeBytes }
      let free = lowest?.freeBytes
      var settings: SettingsPayload?
      if budget == nil {
        await machineSettings.refresh()
        settings = await machineSettings.error == nil ? machineSettings.payload : nil
      }
      let limits =
        budget
        ?? settings.map { settings in
          (
            minFree: settings.entry("budget.minFreeDiskGb")?.number ?? 0,
            hardFloor: settings.entry("budget.hardFloorDiskGb")?.number ?? 0
          )
        }
      var plan = free.flatMap { free in
        limits.flatMap { PressurePlan.make(freeBytes: free, minimumFreeGb: $0.minFree, hardFloorGb: $0.hardFloor, report: nil) }
      }
      let fresh = plan == nil ? nil : await gc.report(maxAge: Self.reportMaxAge)
      let known = free != nil && limits != nil && (plan == nil || fresh != nil)
      if let free, let limits, plan != nil, fresh != nil {
        plan = PressurePlan.make(freeBytes: free, minimumFreeGb: limits.minFree, hardFloorGb: limits.hardFloor, report: fresh)
      }
      let result = plan
      await MainActor.run {
        self.checking = false
        self.lowestVolume = lowest
        if budget == nil, let limits {
          self.budget = limits
          self.budgetAt = now
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
    let wants = defaults.bool(forKey: AppPreferences.Key.autopilotPressure)
    if wants, !plan.isEmpty, status.payload == nil { return }
    if wants, !plan.isEmpty, cliCleansAutomatically, cliMaintenance?.lastPass?.blocked.isEmpty ?? true { return }
    let acts = wants && !cliCleansAutomatically
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
    completion: ((ActionRun, String?) -> Void)? = nil
  ) {
    let command = StimCommand(arguments, cwd: NSHomeDirectory())
    let titles = Dictionary(
      (status.payload?.environments.map { ($0.path, $0.names.title) } ?? [])
        + (status.payload?.unprovisionedWorktrees?.map { ($0.path, $0.names.title) } ?? []),
      uniquingKeysWith: { first, _ in first })
    actions.run(title, steps: [command], key: ActionCenter.machineKey, present: present) { [weak self] run in
      guard let self else { return }
      self.checkPressure(maxAge: 0)
      let summary = run.gcOutcome.flatMap { try? $0.get() }.map {
        $0.summary(name: { titles[$0] ?? PathNames(path: $0).title })
      }
      self.record(
        AutopilotLogEntry(
          date: Date(), trigger: trigger, command: "stim \(arguments.joined(separator: " "))",
          exitStatus: run.launchError == nil ? run.exitStatus : nil, note: summary ?? run.summary))
      completion?(run, summary)
    }
  }

  private func record(_ entry: AutopilotLogEntry) {
    log = AutopilotLog.appending(entry, to: log)
    defaults.set(AutopilotLog.encode(log), forKey: AppPreferences.Key.autopilotLog)
  }
}
