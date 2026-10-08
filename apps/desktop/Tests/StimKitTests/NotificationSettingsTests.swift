import Foundation
import StimKit
import Testing

struct NotificationSettingsTests {
  private func defaults(_ name: String) throws -> UserDefaults {
    let defaults = try #require(UserDefaults(suiteName: name))
    defaults.removePersistentDomain(forName: name)
    defaults.register(defaults: NotificationSettings.defaults)
    return defaults
  }

  @Test func defaultsStartedToOffBuildRequestsToAlertAndTheRestToSilent() throws {
    let defaults = try defaults("NotificationSettingsTests.fresh")
    let levels = OversightCategory.desktop.map { NotificationSettings.level($0, defaults) }
    #expect(levels == [.off, .silent, .silent, .silent, .silent, .silent, .alert])
    let prefs = NotificationSettings.prefs(defaults)
    #expect(prefs.categories == [.started, .stuck, .looping, .finished, .machine, .attention, .buildRequest])
    #expect(prefs.stuckMinutes == 15)
    #expect(prefs.quiet == false)
  }

  @Test func readsQuietHoursAcrossMidnightAndAStoredLevel() throws {
    let defaults = try defaults("NotificationSettingsTests.quiet")
    defaults.set("1320-420", forKey: NotificationSettings.quietHoursKey)
    defaults.set("off", forKey: NotificationSettings.key(.started))
    #expect(NotificationSettings.isQuiet(defaults, minuteOfDay: 23 * 60))
    #expect(NotificationSettings.isQuiet(defaults, minuteOfDay: 6 * 60))
    #expect(!NotificationSettings.isQuiet(defaults, minuteOfDay: 12 * 60))
    #expect(NotificationSettings.level(.started, defaults) == .off)
  }

  @Test func keepsALevelTheUserSetForStarted() throws {
    let defaults = try defaults("NotificationSettingsTests.explicit")
    defaults.set("silent", forKey: NotificationSettings.key(.started))
    #expect(NotificationSettings.level(.started, defaults) == .silent)
  }

  @Test func marksTheBacklogReadOnceAndNeverTouchesLaterEntries() throws {
    let defaults = try defaults("NotificationSettingsTests.backlog")
    func entry(_ id: String) -> InboxEntry {
      let notification = OversightNotification(
        id: "finished:/a", category: .finished, title: "t", body: "b", quiet: true, thread: nil,
        target: .workspace(path: "/a"))
      return InboxEntry(id: id, notification: notification, date: Date())
    }
    var inbox = Inbox(entries: [entry("old1"), entry("old2")])
    #expect(NotificationSettings.markBacklogReadOnce(&inbox, defaults))
    #expect(inbox.unreadCount == 0)

    inbox.add(entry("new"), now: Date())
    #expect(!NotificationSettings.markBacklogReadOnce(&inbox, defaults))
    #expect(inbox.entries.filter { !$0.read }.map(\.id) == ["new"])
  }

  @Test func storesAMutedEntryReadSoItNeverBadgesTheBell() {
    let notification = OversightNotification(
      id: "started:/a", category: .started, title: "t", body: "b", quiet: true, thread: nil,
      target: .workspace(path: "/a"))
    #expect(InboxEntry(notification: notification, date: Date(), suppressed: .muted).read)
    #expect(!InboxEntry(notification: notification, date: Date(), suppressed: .quietHours).read)
    #expect(!InboxEntry(notification: notification, date: Date()).read)
  }

  @Test func fallsBackOnStoredValuesItCannotRead() throws {
    let defaults = try defaults("NotificationSettingsTests.bad")
    defaults.set(0, forKey: NotificationSettings.stuckMinutesKey)
    defaults.set("22:00-07:00", forKey: NotificationSettings.quietHoursKey)
    defaults.set("loud", forKey: NotificationSettings.key(.machine))
    #expect(NotificationSettings.prefs(defaults).stuckMinutes == 15)
    #expect(!NotificationSettings.isQuiet(defaults, minuteOfDay: 23 * 60))
    #expect(NotificationSettings.level(.machine, defaults) == .silent)
  }
}
