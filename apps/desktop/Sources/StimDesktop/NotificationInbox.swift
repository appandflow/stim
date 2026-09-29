import Foundation
import StimKit

@MainActor
final class NotificationInbox: ObservableObject {
  static let shared = NotificationInbox()

  @Published private(set) var inbox: Inbox

  private let file: URL?

  init() {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
    file = support?.appendingPathComponent(Bundle.main.bundleIdentifier ?? "StimDesktop", isDirectory: true)
      .appendingPathComponent("notifications.json")
    var stored =
      file.flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONDecoder().decode(Inbox.self, from: $0) }
      ?? Inbox()
    stored.prune(now: Date())
    inbox = stored
    Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { _ in
      MainActor.assumeIsolated { NotificationInbox.shared.update { $0.prune(now: Date()) } }
    }
  }

  func add(_ entry: InboxEntry) { update { $0.add(entry, now: Date()) } }
  func markRead(_ id: String) { update { $0.markRead(id) } }
  func markAllRead(_ filter: InboxFilter) { update { $0.markAllRead(filter) } }
  func clear(_ filter: InboxFilter) { update { $0.clear(filter) } }

  func open(_ entry: InboxEntry) {
    markRead(entry.id)
    NoticeRouter.open(entry.target)
  }

  private func update(_ change: (inout Inbox) -> Void) {
    var next = inbox
    change(&next)
    guard next != inbox else { return }
    inbox = next
    guard let file, let data = try? JSONEncoder().encode(next) else { return }
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: file, options: .atomic)
  }
}
