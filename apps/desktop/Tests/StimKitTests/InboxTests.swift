import Foundation
import StimKit
import Testing

struct InboxTests {
  private let now = Date(timeIntervalSince1970: 1_790_000_000)

  private func entry(_ id: String, _ category: OversightCategory, _ target: OversightTarget, ago: TimeInterval)
    -> InboxEntry
  {
    let notification = OversightNotification(
      id: "\(category.rawValue):x", category: category, title: "t", body: "b", quiet: false, thread: nil,
      target: target)
    return InboxEntry(id: id, notification: notification, date: now.addingTimeInterval(-ago))
  }

  @Test func keepsTheNewest200FromTheLast7Days() {
    var inbox = Inbox()
    inbox.add(entry("old", .machine, .machine, ago: 7 * 24 * 3600 + 1), now: now)
    #expect(inbox.entries.isEmpty)
    for n in 0..<205 { inbox.add(entry("e\(n)", .started, .workspace(path: "/a"), ago: 0), now: now) }
    #expect(inbox.entries.count == 200)
    #expect(inbox.entries.first?.id == "e204")
    #expect(inbox.entries.last?.id == "e5")
  }

  @Test func marksReadAndClearsOnlyWhatTheFilterShows() {
    var inbox = Inbox()
    inbox.add(entry("a", .stuck, .device(path: "/a", platform: "ios", slot: "default"), ago: 60), now: now)
    inbox.add(entry("b", .looping, .build(path: "/b", platform: "ios"), ago: 30), now: now)
    inbox.add(entry("m", .machine, .machine, ago: 10), now: now)
    #expect(inbox.unreadCount == 3)
    inbox.markAllRead(InboxFilter(workspace: "/a"))
    #expect(inbox.entries.filter { !$0.read }.map(\.id) == ["m", "b"])
    inbox.clear(InboxFilter(workspace: ""))
    #expect(inbox.entries.map(\.id) == ["b", "a"])
    #expect(inbox.days(InboxFilter(category: .looping)).flatMap(\.entries).map(\.id) == ["b"])
    #expect(inbox.workspaces.map(\.path) == ["/b", "/a"])
  }

  @Test func workspacesAndRowsSharingATitleShowTheirEnclosingFolders() {
    func titled(_ id: String, _ title: String, _ path: String) -> InboxEntry {
      var e = entry(id, .finished, .workspace(path: path), ago: 0)
      e.title = title
      return e
    }
    var inbox = Inbox()
    inbox.add(titled("a", "app", "/w/code/app"), now: now)
    inbox.add(titled("b", "app", "/w/work/app"), now: now)
    inbox.add(titled("c", "other", "/w/code/other"), now: now)
    #expect(inbox.workspaces.map(\.title) == ["other", "app (work)", "app (code)"])
    #expect(inbox.displayTitles == ["a": "app (code)", "b": "app (work)", "c": "other"])
  }

  @Test func groupsByLocalDayNewestFirst() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    var inbox = Inbox()
    inbox.add(entry("yesterday", .finished, .workspace(path: "/a"), ago: 26 * 3600), now: now)
    inbox.add(entry("today1", .finished, .workspace(path: "/a"), ago: 60), now: now)
    inbox.add(entry("today2", .finished, .workspace(path: "/a"), ago: 30), now: now)
    let days = inbox.days(InboxFilter(), calendar: calendar)
    #expect(days.map { $0.entries.map(\.id) } == [["today2", "today1"], ["yesterday"]])
  }

  @Test func interruptsOnlyForAnAlertOutsideQuietHoursAndLabelsWhatItHolds() {
    #expect(Inbox.delivery(.alert, quiet: false) == (true, nil))
    #expect(Inbox.delivery(.alert, quiet: true) == (false, .quietHours))
    #expect(Inbox.delivery(.silent, quiet: true) == (false, nil))
    #expect(Inbox.delivery(.off, quiet: false) == (false, .muted))
  }

  @Test func keepsTheHistoryWhenOneStoredEntryIsUnreadable() throws {
    var inbox = Inbox()
    inbox.add(entry("a", .stuck, .workspace(path: "/a"), ago: 60), now: now)
    var json = try #require(String(data: JSONEncoder().encode(inbox), encoding: .utf8))
    json = json.replacingOccurrences(of: "{\"entries\":[", with: "{\"entries\":[{\"category\":\"attention\"},")
    let decoded = try JSONDecoder().decode(Inbox.self, from: Data(json.utf8))
    #expect(decoded.entries.map(\.id) == ["a"])
  }
}
