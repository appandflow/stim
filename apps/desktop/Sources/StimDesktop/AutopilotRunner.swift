import AppKit
import StimKit

/// Runs Stim's cleanup commands on a schedule while the app runs: `stim gc --idle` for idle devices,
/// a nightly `stim gc --delete`, and `stim gc --delete` when free disk falls under the Stim budget.
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

  private let status: StatusStore
  private let actions: ActionCenter
  private let cli: Task<StimCLI, Never>
  private var timer: Timer?
  private var checking = false
  private var lastIdleRun: Date?
  private var lastPressureRun: Date?
  private var budget: (minFree: Double, hardFloor: Double)?
  private var budgetAt: Date?
  private var report: GcReport?
  private var reportAt: Date?
  private var notifiedEpisode = false
  private var nightlyHour: Int?

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
    if defaults.bool(forKey: AppPreferences.Key.notifiesDiskPressure) { Notifier.requestAuthorization() }
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
  /// only while disk is still under the budget, and otherwise opens Storage.
  func runPlanFromNotification() {
    NSApp.activate(ignoringOtherApps: true)
    guard let plan = pressure, !plan.isEmpty else {
      OpenRequests.shared.showsStorage = true
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
      lastPressureRun = now
      run(.nightly, "Nightly cleanup", ["gc", "--delete"], present: false)
      return
    }
    let minutes = defaults.integer(forKey: AppPreferences.Key.autopilotIdleMinutes)
    if idle, defaults.bool(forKey: AppPreferences.Key.autopilotIdleShutdown), minutes > 0,
      lastIdleRun.map({ now.timeIntervalSince($0) >= Self.idleRetry }) ?? true,
      AutopilotSchedule.idleShutdownDue(bootedDevices, minutes: minutes, now: now)
    {
      lastIdleRun = now
      run(.idle, "Shut down idle devices", ["gc", "--idle", AutopilotSchedule.idleDuration(minutes: minutes)], present: false)
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
      let lowest = volumes.min { $0.availableBytes < $1.availableBytes }
      let free = volumes.map { $0.unpurgeableFreeBytes ?? $0.availableBytes }.min()
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

  private func record(_ entry: AutopilotLogEntry) {
    log = AutopilotLog.appending(entry, to: log)
    defaults.set(AutopilotLog.encode(log), forKey: AppPreferences.Key.autopilotLog)
  }
}
