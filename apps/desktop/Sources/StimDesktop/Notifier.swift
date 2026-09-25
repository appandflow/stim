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
