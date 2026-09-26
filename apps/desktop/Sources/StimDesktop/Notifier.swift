import Combine
import Foundation
import StimKit
import UserNotifications

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

  @MainActor func install() {
    guard Notifier.isAvailable else { return }
    let center = UNUserNotificationCenter.current()
    center.setNotificationCategories([
      UNNotificationCategory(
        identifier: Notifier.pressureCategory,
        actions: [UNNotificationAction(identifier: Notifier.doItAction, title: "Do it", options: [.foreground])],
        intentIdentifiers: [])
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
        if action == Notifier.doItAction {
          self.runPlan?()
        } else if id.hasPrefix("pressure") {
          OpenRequests.shared.showsMachine = true
        }
      }
      completionHandler()
    }
  }

  /// Without a delegate macOS shows no banner while the app is active; only pressure notifications change that.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler(notification.request.identifier.hasPrefix("pressure") ? [.banner, .sound] : [])
  }
}
