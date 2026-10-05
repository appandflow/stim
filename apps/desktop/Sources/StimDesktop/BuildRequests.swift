import AppKit
import Combine
import StimKit
import UserNotifications

@MainActor
final class BuildRequestNotifier {
  static let shared = BuildRequestNotifier(server: .shared)

  private let server: ServerController
  private var subscription: AnyCancellable?
  private var announced: [String: String] = [:]

  init(server: ServerController) {
    self.server = server
  }

  func start() {
    guard subscription == nil else { return }
    subscription = server.$devices.sink { [weak self] devices in self?.receive(devices) }
  }

  private func receive(_ devices: [PairedDevice]) {
    let pending = devices.filter { $0.pendingUntil != nil }
    let ids = Set(pending.map(\.id))
    for (id, entry) in announced where !ids.contains(id) {
      withdraw(id)
      NotificationInbox.shared.markRead(entry)
      announced[id] = nil
    }
    for device in pending where announced[device.id] == nil { announced[device.id] = announce(device) }
  }

  static func notificationID(_ id: String) -> String { "build-request:\(id)" }

  private func announce(_ device: PairedDevice) -> String {
    let notification = OversightNotification(
      id: Self.notificationID(device.id), category: .buildRequest,
      title: device.isDeviceHostClient
        ? "\(device.name) wants to run devices on this Mac" : "\(device.name) wants to build on this Mac",
      body: "From \(device.node). Review it to allow or deny.", quiet: false, thread: "build-requests",
      target: .buildRequest(id: device.id))
    let clock = Calendar.current.dateComponents([.hour, .minute], from: Date())
    let quiet = NotificationSettings.isQuiet(.standard, minuteOfDay: (clock.hour ?? 0) * 60 + (clock.minute ?? 0))
    let delivery = Inbox.delivery(NotificationSettings.level(.buildRequest, .standard), quiet: quiet)
    let entry = InboxEntry(notification: notification, date: Date(), suppressed: delivery.suppressed)
    NotificationInbox.shared.add(entry)
    guard delivery.interrupts else { return entry.id }
    if MainWindow.isInFront {
      ToastCenter.shared.show(OversightNotifier.toast(notification, entry: entry.id))
    } else {
      Notifier.postOversight(notification, entry: entry.id)
    }
    return entry.id
  }

  private func withdraw(_ id: String) {
    let key = Self.notificationID(id)
    ToastCenter.shared.dismiss(key: key)
    guard Notifier.isAvailable else { return }
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: [Notifier.oversightPrefix + key])
    center.removeDeliveredNotifications(withIdentifiers: [Notifier.oversightPrefix + key])
  }
}

@MainActor
enum BuildRequestPrompt {
  static func present(id: String) {
    let server = ServerController.shared
    NSApp.activate(ignoringOtherApps: true)
    guard let device = server.devices.first(where: { $0.id == id && $0.pendingUntil != nil }) else {
      let alert = NSAlert()
      alert.messageText = "This machine request is no longer pending"
      alert.informativeText =
        "It was allowed or denied, or it lapsed after 15 minutes. Settings > Phones lists this Mac's approved clients."
      alert.runModal()
      return
    }
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText =
      device.isDeviceHostClient
      ? "\(device.name) wants to run devices on this Mac" : "\(device.name) wants to build on this Mac"
    let lapses = device.pendingUntil.map { " It lapses at \($0.formatted(date: .omitted, time: .shortened))." } ?? ""
    let permission =
      device.isDeviceHostClient
      ? "Allow approves this Mac for hosted simulator and emulator sessions. Hosted sessions are not available yet. It does not grant build access or read/control access to unrelated workspaces or devices."
      : "It can run its project's code on this Mac to build: config plugins, CocoaPods hooks, Xcode script phases and Gradle plugins run as your user. It cannot read your workspaces or control your devices."
    alert.informativeText = """
      Tailnet node: \(device.node)
      Request: \(device.id).\(lapses)

      Allow only a Mac you expect. \(permission) Revoke it any time in Settings > Phones.
      """
    let allow = alert.addButton(withTitle: "Allow")
    allow.keyEquivalent = ""
    alert.addButton(withTitle: "Deny")
    alert.addButton(withTitle: "Later").keyEquivalent = "\u{1b}"
    switch alert.runModal() {
    case .alertFirstButtonReturn: server.allowMachine(device)
    case .alertSecondButtonReturn: server.revoke(device)
    default: break
    }
  }
}
