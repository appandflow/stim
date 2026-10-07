import Foundation
import Testing

@testable import StimKit

@Suite struct DeviceFramePreferenceTests {
  private func defaults() -> UserDefaults {
    let name = "DeviceFramePreferenceTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return defaults
  }

  @Test func framesAreOnUntilTurnedOff() {
    let defaults = defaults()
    #expect(DeviceFramePreference.isOn("ios.iPhone Duo", defaults))
    DeviceFramePreference.set(false, "ios.iPhone Duo", defaults)
    #expect(!DeviceFramePreference.isOn("ios.iPhone Duo", defaults))
  }

  @Test func theChoiceBelongsToOneDeviceType() {
    let defaults = defaults()
    DeviceFramePreference.set(false, "ios.iPhone Duo", defaults)
    #expect(DeviceFramePreference.isOn("ios.iPhone 18 Pro", defaults))
    #expect(DeviceFramePreference.isOn("android.pixel_8", defaults))
  }
}
