import AppKit
import Combine
import StimKit
import StimStores
import SystemConfiguration

@MainActor
final class OversightNotifier: ObservableObject {
  static let tick: TimeInterval = 30

  private let store: StatusStore
  private let disks: DiskVolumeStore
  private let machine: String
  var keptWorktrees: @MainActor () -> [PullRequestCleanup.Flag] = { [] }
  private var attention = Set(UserDefaults.standard.stringArray(forKey: NotificationSettings.attentionKey) ?? [])
  private let awakeSince = Date().timeIntervalSince1970 * 1000
  private var state: OversightState?
  private var volumes: [OversightInput.Volume]?
  private var probing = false
  private var subscription: AnyCancellable?
  private var timer: Timer?
  private var wakeTimer: Timer?

  init(store: StatusStore, disks: DiskVolumeStore) {
    self.store = store
    self.disks = disks
    machine = (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? ProcessInfo.processInfo.hostName
  }

  func start() {
    guard subscription == nil else { return }
    subscription = store.$payload.compactMap { $0 }.sink { [weak self] payload in self?.evaluate(payload) }
    timer = Timer.scheduledTimer(withTimeInterval: Self.tick, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.probeVolumes() }
    }
  }

  private func probeVolumes() {
    guard !probing, store.payload != nil else { return }
    probing = true
    Task {
      let volumes = await disks.volumes(maxAge: Self.tick / 2)
      probing = false
      self.volumes = volumes.map { OversightInput.Volume(freeBytes: Double($0.freeBytes)) }
      evaluate(nil)
    }
  }

  private func evaluate(_ latest: StatusPayload?) {
    guard let payload = latest ?? store.payload else { return }
    if volumes == nil { probeVolumes() }
    let now = Date()
    let input = OversightInput(
      machine: machine, status: payload.oversight, volumes: volumes, memoryPressure: memoryPressure())
    let clock = Calendar.current.dateComponents([.hour, .minute], from: now)
    let minuteOfDay = (clock.hour ?? 0) * 60 + (clock.minute ?? 0)
    let result = Oversight.oversee(
      previous: state, input: input, prefs: NotificationSettings.prefs(.standard),
      now: now.timeIntervalSince1970 * 1000, awakeSince: awakeSince)
    state = result.state
    let quiet = NotificationSettings.isQuiet(.standard, minuteOfDay: minuteOfDay)
    for notification in result.notifications + overseeAttention() {
      deliver(notification, NotificationSettings.level(notification.category, .standard), quiet: quiet)
    }
    wakeTimer?.invalidate()
    wakeTimer = result.wakeAt.map { at in
      Timer.scheduledTimer(withTimeInterval: max(0, at / 1000 - now.timeIntervalSince1970), repeats: false) {
        [weak self] _ in
        MainActor.assumeIsolated { self?.evaluate(nil) }
      }
    }
  }

  private func overseeAttention() -> [OversightNotification] {
    let doctorKnown = Set(store.doctor.keys)
    let result = AttentionNotices.update(
      previous: attention, items: store.attention(lowestVolume: nil), kept: keptWorktrees(), machine: machine,
      title: { store.names(ofPath: $0).title },
      pending: { id in
        guard id.hasPrefix("setup-") || id.hasPrefix("doctor-failed:"), let split = id.range(of: ":/") else {
          return false
        }
        return !doctorKnown.contains(String(id[id.index(after: split.lowerBound)...]))
      })
    if result.active != attention {
      attention = result.active
      UserDefaults.standard.set(attention.sorted(), forKey: NotificationSettings.attentionKey)
    }
    return result.notifications
  }

  private func memoryPressure() -> MemoryPressureLevel? {
    switch MachineMemory.read()?.pressure {
    case .normal: return .normal
    case .warning: return .warning
    case .critical: return .critical
    case nil: return nil
    }
  }

  private func deliver(_ notification: OversightNotification, _ level: NotificationLevel, quiet: Bool) {
    let delivery = Inbox.delivery(level, quiet: quiet)
    let entry = InboxEntry(notification: notification, date: Date(), suppressed: delivery.suppressed)
    NotificationInbox.shared.add(entry)
    guard delivery.interrupts else { return }
    if MainWindow.isInFront {
      ToastCenter.shared.show(Self.toast(notification, entry: entry.id))
    } else {
      Notifier.postOversight(notification, entry: entry.id)
    }
  }

  static func toast(_ notification: OversightNotification, entry: String) -> Toast {
    let target = notification.target
    return Toast(
      icon: notification.category.symbol, tone: tone(notification.category), title: notification.title,
      body: notification.body,
      action: Toast.Action(title: target.actionTitle) {
        NotificationInbox.shared.markRead(entry)
        NoticeRouter.open(target)
      },
      sticky: notification.category.needsAttention, key: notification.id)
  }

  static func tone(_ category: OversightCategory) -> Tone {
    switch category {
    case .started: return .accent
    case .finished: return .success
    case .stuck, .looping: return .warning
    case .machine, .control: return .error
    case .buildRequest, .attention: return .warning
    }
  }
}

enum NoticeRouter {
  @MainActor static func open(_ target: OversightTarget) {
    if case .url(_, let url) = target, let link = URL(string: url) {
      NSWorkspace.shared.open(link)
      return
    }
    if case .buildRequest(let id) = target {
      DispatchQueue.main.async { MainActor.assumeIsolated { BuildRequestPrompt.present(id: id) } }
      return
    }
    MainWindow.show()
    OpenRequests.shared.target = target
  }
}
