import Combine
import Foundation
import StimKit
import StimStores
@preconcurrency import UserNotifications

/// Posts a macOS notification for each enabled `StatusEvent` between two status refreshes.
@MainActor
final class Notifier: ObservableObject {
  private let store: StatusStore
  private var previous: StatusPayload?
  private var reportedSessions: Set<String> = []
  private var subscription: AnyCancellable?

  init(store: StatusStore) {
    self.store = store
  }

  /// UNUserNotificationCenter needs an app bundle; `swift run` has none.
  static var isAvailable: Bool { Bundle.main.bundleIdentifier != nil }

  static func isEnabled(_ kind: StatusEvent.Kind) -> Bool {
    UserDefaults.standard.bool(forKey: AppPreferences.Key.notifies(kind))
  }

  static func requestAuthorization() {
    guard isAvailable else { return }
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }

  static let pressureCategory = "diskPressure"
  static let doItAction = "doIt"

  static func removeDeliveredPressure() {
    guard isAvailable else { return }
    UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
      UNUserNotificationCenter.current().removeDeliveredNotifications(
        withIdentifiers: delivered.map(\.request.identifier).filter { $0.hasPrefix("pressure") })
    }
  }

  /// Posts a disk pressure notification. With `offersPlan`, it carries a Do it button that runs the plan.
  static func postPressure(id: String, title: String, body: String, offersPlan: Bool) {
    guard isAvailable, UserDefaults.standard.bool(forKey: AppPreferences.Key.notifiesDiskPressure) else { return }
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.categoryIdentifier = offersPlan ? pressureCategory : ""
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
  }

  /// Posts that the autopilot removed worktrees whose pull request was merged or closed.
  static func postWorktreesRemoved(title: String, body: String) {
    guard isAvailable, UserDefaults.standard.bool(forKey: AppPreferences.Key.notifiesWorktreeRemoval) else { return }
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    UNUserNotificationCenter.current().add(
      UNNotificationRequest(identifier: "worktrees-\(Date().timeIntervalSince1970)", content: content, trigger: nil))
  }

  nonisolated static let oversightPrefix = "oversight:"
  nonisolated static let targetKey = "target"
  nonisolated static let entryKey = "entry"

  /// Posts an oversight notification as a banner with sound, asking for permission the first time one is needed. The
  /// request id is the notification's, so a later episode replaces the earlier one in Notification Center.
  static func postOversight(_ notification: OversightNotification, entry: String) {
    guard isAvailable, let target = try? JSONEncoder().encode(notification.target) else { return }
    let content = UNMutableNotificationContent()
    content.title = notification.title
    content.body = notification.body
    content.sound = .default
    if let thread = notification.thread { content.threadIdentifier = thread }
    content.userInfo = [targetKey: String(decoding: target, as: UTF8.self), entryKey: entry]
    let request = UNNotificationRequest(
      identifier: oversightPrefix + notification.id, content: content, trigger: nil)
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      switch settings.authorizationStatus {
      case .notDetermined:
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in if granted { center.add(request) } }
      case .denied:
        break
      default:
        center.add(request)
      }
    }
  }

  nonisolated static let discoveryPrefix = "discovery:"
  nonisolated static let discoveryCategory = "discovery"
  nonisolated static let discoveryNeverAction = "discoveryNever"

  static func postDiscovery(_ prompt: DiscoveryPrompt, allowed: @MainActor () -> Bool) async -> Bool {
    guard isAvailable else { return false }
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    switch settings.authorizationStatus {
    case .notDetermined:
      guard (try? await center.requestAuthorization(options: [.alert, .sound])) == true else { return false }
    case .denied: return false
    default: break
    }
    guard allowed() else { return false }
    let content = UNMutableNotificationContent()
    content.title = prompt.title
    content.body = prompt.detail ?? ""
    content.categoryIdentifier = discoveryCategory
    content.sound = .default
    do {
      try await center.add(
        UNNotificationRequest(identifier: discoveryPrefix + prompt.type.rawValue, content: content, trigger: nil))
      return true
    } catch { return false }
  }

  func start() {
    guard subscription == nil else { return }
    subscription = store.$payload.compactMap { $0 }.sink { [weak self] payload in
      self?.receive(payload)
    }
  }

  private func receive(_ payload: StatusPayload) {
    defer { previous = payload }
    guard let previous else { return }
    let minutes = UserDefaults.standard.integer(forKey: AppPreferences.Key.remoteSessionMinutes)
    let events = StatusEvents.events(
      previous: previous, current: payload, now: Date(), remoteMinutes: minutes > 0 ? minutes : 30,
      reported: reportedSessions)
    for event in events {
      if event.kind == .remoteSession { reportedSessions.insert(event.id) }
      guard Self.isAvailable, Self.isEnabled(event.kind) else { continue }
      let content = UNMutableNotificationContent()
      content.title = event.title
      content.body = event.body
      UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: event.id, content: content, trigger: nil))
    }
  }
}

/// Handles the Do it button of a disk pressure notification, and opens the Machine page when one is clicked.
final class NotificationResponder: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
  static let shared = NotificationResponder()

  @MainActor var runPlan: (() -> Void)?
  @MainActor var discoveryResponse: ((DiscoveryType, Bool) -> Void)?

  @MainActor func install() {
    guard Notifier.isAvailable else { return }
    let center = UNUserNotificationCenter.current()
    center.setNotificationCategories([
      UNNotificationCategory(
        identifier: Notifier.pressureCategory,
        actions: [UNNotificationAction(identifier: Notifier.doItAction, title: "Do it", options: [.foreground])],
        intentIdentifiers: []),
      UNNotificationCategory(
        identifier: Notifier.discoveryCategory,
        actions: [UNNotificationAction(identifier: Notifier.discoveryNeverAction, title: "Don't suggest again", options: [])],
        intentIdentifiers: []),
    ])
    center.delegate = self
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let action = response.actionIdentifier
    let id = response.notification.request.identifier
    DispatchQueue.main.async {
      MainActor.assumeIsolated {
        if id.hasPrefix(Notifier.discoveryPrefix) {
          if let type = DiscoveryType(rawValue: String(id.dropFirst(Notifier.discoveryPrefix.count))),
            action != UNNotificationDismissActionIdentifier
          {
            self.discoveryResponse?(type, action == Notifier.discoveryNeverAction)
          }
        } else if action == Notifier.doItAction {
          self.runPlan?()
        } else if id.hasPrefix("pressure") {
          OpenRequests.shared.showsMachine = true
        } else if id.hasPrefix(Notifier.oversightPrefix) {
          let info = response.notification.request.content.userInfo
          if let entry = info[Notifier.entryKey] as? String { NotificationInbox.shared.markRead(entry) }
          if let json = info[Notifier.targetKey] as? String,
            let target = try? JSONDecoder().decode(OversightTarget.self, from: Data(json.utf8))
          {
            NoticeRouter.open(target)
          }
        }
      }
      completionHandler()
    }
  }

  /// Without a delegate macOS shows no banner while the app is active; only pressure and oversight notifications
  /// change that. An oversight one is posted only while the main window is not in front.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let id = notification.request.identifier
    completionHandler(
      id.hasPrefix("pressure") || id.hasPrefix(Notifier.oversightPrefix) || id.hasPrefix(Notifier.discoveryPrefix)
        ? [.banner, .sound] : [])
  }
}
