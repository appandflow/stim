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

  @Test func alertsOnlyMachineProblemsByDefaultAndRunsEveryCategory() throws {
    let defaults = try defaults("NotificationSettingsTests.fresh")
    let levels = OversightCategory.desktop.map { NotificationSettings.level($0, defaults) }
    #expect(levels == [.silent, .silent, .silent, .silent, .alert])
    let prefs = NotificationSettings.prefs(defaults)
    #expect(prefs.categories == [.started, .stuck, .looping, .finished, .machine])
    #expect(prefs.stuckMinutes == 15)
    #expect(prefs.quiet == false)
  }

  @Test func quietHoursAcrossMidnightTurnAnAlertSilentAndLeaveOffAlone() throws {
    let defaults = try defaults("NotificationSettingsTests.quiet")
    defaults.set("1320-420", forKey: NotificationSettings.quietHoursKey)
    defaults.set("off", forKey: NotificationSettings.key(.started))
    #expect(NotificationSettings.presentation(.machine, defaults, minuteOfDay: 23 * 60) == .silent)
    #expect(NotificationSettings.presentation(.machine, defaults, minuteOfDay: 6 * 60) == .silent)
    #expect(NotificationSettings.presentation(.machine, defaults, minuteOfDay: 12 * 60) == .alert)
    #expect(NotificationSettings.presentation(.started, defaults, minuteOfDay: 23 * 60) == .off)
  }

  @Test func fallsBackOnStoredValuesItCannotRead() throws {
    let defaults = try defaults("NotificationSettingsTests.bad")
    defaults.set(0, forKey: NotificationSettings.stuckMinutesKey)
    defaults.set("22:00-07:00", forKey: NotificationSettings.quietHoursKey)
    defaults.set("loud", forKey: NotificationSettings.key(.machine))
    #expect(NotificationSettings.prefs(defaults).stuckMinutes == 15)
    #expect(!NotificationSettings.isQuiet(defaults, minuteOfDay: 23 * 60))
    #expect(NotificationSettings.level(.machine, defaults) == .alert)
  }
}
