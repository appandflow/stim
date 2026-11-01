import AppKit
import Combine
import StimKit
import StimStores

@MainActor
final class AutopilotRunner: ObservableObject {
  static let tick: TimeInterval = 60
  static let budgetMaxAge: TimeInterval = 30 * 60
  static let reportMaxAge: TimeInterval = 10 * 60

  /// Set while free disk is under the Stim budget.
  @Published private(set) var pressure: PressurePlan?
  /// The volume Stim writes to with the least free space, measured on every check.
  @Published private(set) var lowestVolume: DiskVolume?
  /// The CLI's automatic maintenance as the last `stim status --json` reported it; nil from a `stim` without it.
  @Published private(set) var cliMaintenance: MaintenanceStatus?
  @Published private(set) var statusLoaded = false

  private let status: StatusStore
  private let actions: ActionCenter
  private let gc: GcReportStore
  private let disks: DiskVolumeStore
  private let settings: MachineSettingsStore
  private var timer: Timer?
  private var checking = false
  private(set) var budget: (minFree: Double, hardFloor: Double)?
  private var budgetAt: Date?
  private var notifiedEpisode = false
  private var maintenanceSubscription: AnyCancellable?

  init(
    status: StatusStore, actions: ActionCenter, gc: GcReportStore, disks: DiskVolumeStore, settings: MachineSettingsStore
  ) {
    self.status = status
    self.actions = actions
    self.gc = gc
    self.disks = disks
    self.settings = settings
    maintenanceSubscription = status.$payload.map { ($0 != nil, $0?.maintenance) }.removeDuplicates { $0 == $1 }
      .sink { [weak self] loaded, maintenance in
        self?.statusLoaded = loaded
        self?.cliMaintenance = maintenance
      }
  }

  private var defaults: UserDefaults { .standard }

  func start() {
    guard timer == nil else { return }
    NotificationResponder.shared.runPlan = { [weak self] in self?.runPlanFromNotification() }
    if defaults.bool(forKey: AppPreferences.Key.notifiesDiskPressure) {
      Notifier.requestAuthorization()
    }
    timer = Timer.scheduledTimer(withTimeInterval: Self.tick, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.checkPressure(maxAge: Self.tick / 2) }
    }
    Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.checkPressure(maxAge: Self.tick / 2) }
    }
  }

  /// The Do it of a pressure notification, which can be clicked long after it was posted: it runs the plan
  /// only while disk is still under the budget, and otherwise opens the Machine page.
  func runPlanFromNotification() {
    NSApp.activate(ignoringOtherApps: true)
    guard let plan = pressure, !plan.isEmpty else {
      OpenRequests.shared.showsMachine = true
      return
    }
    runPressurePlan()
  }

  func runPressurePlan() {
    run("Reclaim disk space", PressurePlan.arguments)
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
    guard status.payload != nil, !notifiedEpisode, MaintenanceStatus.asksAboutDiskPressure(cliMaintenance) else { return }
    notifiedEpisode = true
    Notifier.postPressure(
      id: "pressure-\(Date().timeIntervalSince1970)", title: plan.headline, body: plan.proposal, offersPlan: !plan.isEmpty)
  }

  private func run(_ title: String, _ arguments: [String]) {
    actions.run(
      title, steps: [StimCommand(arguments, cwd: NSHomeDirectory())], key: ActionCenter.machineKey, present: true
    ) { [weak self] _ in
      self?.checkPressure(maxAge: 0)
    }
  }
}
