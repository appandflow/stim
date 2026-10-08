import Foundation
import Testing

@testable import StimKit

private func withDefaults(_ body: (UserDefaults) throws -> Void) throws {
  let suite = "FeatureFlagsTests-\(UUID().uuidString)"
  let defaults = try #require(UserDefaults(suiteName: suite))
  defer { defaults.removePersistentDomain(forName: suite) }
  try body(defaults)
}

@Test func phoneAppIsOffOnAFreshMacAndFollowsItsOverride() throws {
  try withDefaults { defaults in
    #expect(!FeatureFlags.isEnabled(.phoneApp, defaults: defaults))
    FeatureFlags.set(.phoneApp, enabled: true, defaults: defaults)
    #expect(FeatureFlags.isEnabled(.phoneApp, defaults: defaults))
    #expect(FeatureFlags.isOverridden(.phoneApp, defaults: defaults))
    FeatureFlags.reset(defaults: defaults)
    #expect(!FeatureFlags.isEnabled(.phoneApp, defaults: defaults))
    #expect(!FeatureFlags.isOverridden(.phoneApp, defaults: defaults))
  }
}

@Test func aLaunchArgumentStyleStringSetsTheFlag() throws {
  try withDefaults { defaults in
    defaults.set("YES", forKey: FeatureFlag.phoneApp.overrideKey)
    #expect(FeatureFlags.isEnabled(.phoneApp, defaults: defaults))
    defaults.set("NO", forKey: FeatureFlag.phoneApp.overrideKey)
    #expect(!FeatureFlags.isEnabled(.phoneApp, defaults: defaults))
  }
}

@Test func aMacServingPhonesDefaultsTheFlagOnAndResetKeepsIt() throws {
  try withDefaults { defaults in
    #expect(FeatureFlags.seed(servesPhones: true, pairedPhones: nil, defaults: defaults))
    #expect(FeatureFlags.isEnabled(.phoneApp, defaults: defaults))
    FeatureFlags.set(.phoneApp, enabled: false, defaults: defaults)
    #expect(!FeatureFlags.isEnabled(.phoneApp, defaults: defaults))
    FeatureFlags.reset(defaults: defaults)
    #expect(FeatureFlags.isEnabled(.phoneApp, defaults: defaults))
  }
}

@Test func aMacWithPairedPhonesDefaultsTheFlagOn() throws {
  try withDefaults { defaults in
    #expect(FeatureFlags.seed(servesPhones: false, pairedPhones: 2, defaults: defaults))
    #expect(FeatureFlags.isEnabled(.phoneApp, defaults: defaults))
  }
}

@Test func aMacWithoutPhonesDefaultsTheFlagOffOnceStimServerHasAnswered() throws {
  try withDefaults { defaults in
    #expect(!FeatureFlags.seed(servesPhones: false, pairedPhones: nil, defaults: defaults))
    #expect(defaults.object(forKey: FeatureFlags.seededKey) == nil)
    #expect(FeatureFlags.seed(servesPhones: false, pairedPhones: 0, defaults: defaults))
    #expect(!FeatureFlags.isEnabled(.phoneApp, defaults: defaults))
  }
}

@Test func theDefaultIsDecidedOnlyOnce() throws {
  try withDefaults { defaults in
    #expect(FeatureFlags.seed(servesPhones: false, pairedPhones: 0, defaults: defaults))
    #expect(!FeatureFlags.seed(servesPhones: true, pairedPhones: 3, defaults: defaults))
    #expect(!FeatureFlags.isEnabled(.phoneApp, defaults: defaults))
  }
}

@Test func theSetupGuideHasNoPhoneStepWithoutThePhoneApp() {
  #expect(!SetupStep.sequence(phoneApp: false).contains(.phone))
  #expect(SetupStep.sequence(phoneApp: true).contains(.phone))
  #expect(SetupStep.notifications.next(phoneApp: false) == .check)
  #expect(SetupStep.notifications.next(phoneApp: true) == .phone)
  #expect(SetupStep.check.previous(phoneApp: false) == .notifications)
  #expect(SetupStep.check.previous(phoneApp: true) == .phone)
}

@Test func theTutorialListsNoPhoneStepWithoutThePhoneApp() {
  #expect(!TutorialSteps.steps(phoneApp: false).contains { $0.id == "phone" })
  #expect(TutorialSteps.steps(phoneApp: true).count == TutorialSteps.steps(phoneApp: false).count + 1)
}

@Test func onlyTheAwayPromptNeedsThePhoneApp() {
  for type in DiscoveryType.allCases {
    #expect(PhoneApp.allows(type, phoneApp: true))
    #expect(PhoneApp.allows(type, phoneApp: false) == (type != .away))
  }
}

@Test func copyNamesPhonesOnlyWithThePhoneApp() {
  func offCopy() -> [String] {
    [
      PhoneApp.Copy.screenPermissionUse(phoneApp: false),
      PhoneApp.Copy.screenPermissionRequest(phoneApp: false),
      PhoneApp.Copy.viewerAppError(phoneApp: false),
      PhoneApp.Copy.notificationRulesPrefix(phoneApp: false),
      PhoneApp.Copy.serverPageName(phoneApp: false),
      PhoneApp.Copy.diffViewerOff(phoneApp: false),
      PhoneApp.Copy.archivedLogsOffline(phoneApp: false),
      PhoneApp.Copy.serverOffForViewing("app's window", phoneApp: false),
      PhoneApp.Copy.serverPopupTitle(missing: true, phoneApp: false),
      PhoneApp.Copy.serverPopupDetail(minimum: "1.0.0", phoneApp: false),
      PhoneApp.Copy.clients(phoneApp: false),
      PhoneApp.Copy.tailscaleDown(phoneApp: false),
      PhoneApp.Copy.recordingFooter(phoneApp: false),
    ]
  }
  for text in offCopy() { #expect(!text.lowercased().contains("phone"), "\(text)") }
  #expect(PhoneApp.Copy.screenPermissionUse(phoneApp: true).contains("phone"))
  #expect(PhoneApp.Copy.serverPageName(phoneApp: true) == "Phones")
}
