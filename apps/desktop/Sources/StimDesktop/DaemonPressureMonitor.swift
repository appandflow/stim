import AppKit
import Combine
import StimKit
import StimStores

/// Follows the stim-daemon's pressure level and last actions in the status stim-server serves, and posts one
/// notification per raised episode that needs a person. The daemon decides and reclaims; this only reports.
@MainActor
final class DaemonPressureMonitor: ObservableObject {
  @Published private(set) var daemon: DaemonStatus?
  /// The CLI's automatic maintenance as the last status reported it; nil from a `stim` without it.
  @Published private(set) var cliMaintenance: MaintenanceStatus?
  @Published private(set) var statusLoaded = false

  private let actions: ActionCenter
  private var subscription: AnyCancellable?
  private var notifiedEpisode = false

  init(status: StatusStore, actions: ActionCenter) {
    self.actions = actions
    subscription = status.$payload.sink { [weak self] payload in self?.update(payload) }
  }

  func start() {
    NotificationResponder.shared.runPlan = { [weak self] in self?.runPlanFromNotification() }
    if UserDefaults.standard.bool(forKey: AppPreferences.Key.notifiesDiskPressure) {
      Notifier.requestAuthorization()
    }
  }

  /// The Do it of a pressure notification, which can be clicked long after it was posted: it runs `stim gc --delete`
  /// only while the level is still raised, and otherwise opens the Machine page.
  func runPlanFromNotification() {
    NSApp.activate(ignoringOtherApps: true)
    guard daemon?.isRaised == true else {
      OpenRequests.shared.showsMachine = true
      return
    }
    freeDiskSpace()
  }

  func freeDiskSpace() {
    actions.run(
      "Reclaim disk space", steps: [StimCommand(["gc", "--delete", "--json"], cwd: NSHomeDirectory())],
      key: ActionCenter.machineKey, present: true)
  }

  private func update(_ payload: StatusPayload?) {
    statusLoaded = payload != nil
    if cliMaintenance != payload?.maintenance { cliMaintenance = payload?.maintenance }
    guard daemon != payload?.daemon else { return }
    daemon = payload?.daemon
    react(to: daemon)
  }

  private func react(to daemon: DaemonStatus?) {
    guard let daemon, daemon.isRaised else {
      if notifiedEpisode { Notifier.removeDeliveredPressure() }
      notifiedEpisode = false
      return
    }
    guard !notifiedEpisode, daemon.asksAboutPressure else { return }
    notifiedEpisode = true
    Notifier.postPressure(
      id: "pressure-\(Date().timeIntervalSince1970)", title: daemon.headline,
      body: daemon.mode == "on" && daemon.running != nil
        ? "The stim-daemon is reclaiming what it safely can. Free space outside Stim, or run stim gc --delete."
        : "No stim-daemon is reclaiming in this Stim home. Run stim gc --delete, or free space outside Stim.",
      offersPlan: true)
  }
}
