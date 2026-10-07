import Foundation

/// Whether the viewer draws a device's installed frame, remembered per device type in `UserDefaults`.
/// Frames are on until a person turns them off.
public enum DeviceFramePreference {
  public static func key(_ deviceType: String) -> String { "viewer.deviceFrame.\(deviceType)" }

  public static func isOn(_ deviceType: String, _ defaults: UserDefaults = .standard) -> Bool {
    defaults.object(forKey: key(deviceType)) as? Bool ?? true
  }

  public static func set(_ on: Bool, _ deviceType: String, _ defaults: UserDefaults = .standard) {
    defaults.set(on, forKey: key(deviceType))
  }
}
