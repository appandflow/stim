import Foundation

public enum LaunchActivation {
  public static func isBackgroundLaunch(_ environment: [String: String]) -> Bool {
    environment["STIM_BACKGROUND_LAUNCH"] == "1"
  }

  /// A Dock click activates the app before the reopen event arrives; `open -g` does not.
  public static func reopenActivates(backgroundLaunch: Bool, appIsActive: Bool) -> Bool {
    !backgroundLaunch || appIsActive
  }
}
