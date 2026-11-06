import Foundation

/// What the phone app flag decides, one function per place that shows something about phones. A view asks here
/// instead of testing the flag itself, so each entry point has one tested answer.
public enum PhoneApp {
  /// Whether a request to open the pairing sheet is honored.
  public static func opensPairing(phoneApp: Bool) -> Bool { phoneApp }

  public static func allows(_ prompt: DiscoveryType, phoneApp: Bool) -> Bool { prompt != .away || phoneApp }

  /// Words that name phones only while the app is on.
  public enum Copy {
    public static func screenPermissionUse(phoneApp: Bool) -> String {
      phoneApp ? "Shows the app's window in Desktop and on your paired phone." : "Shows the app's window in Desktop."
    }

    public static func screenPermissionRequest(phoneApp: Bool) -> String {
      let verify =
        phoneApp
        ? "reconnect the phone viewer to verify the server's capture access" : "reopen the viewer to verify capture access"
      return
        "Allow this Stim app in the system dialog. After granting access, \(verify); if macOS asks for a relaunch, follow its instructions."
    }

    public static func screenPermissionDone(allowed: Bool, phoneApp: Bool) -> String {
      let phone = phoneApp ? " Then reconnect the phone viewer." : ""
      return allowed
        ? "If the preview stays blank, relaunch Stim so macOS applies the new access.\(phone)"
        : "Allow the missing access any time from Stim's Native App Viewer menu or System Settings, then relaunch Stim if the preview stays blank.\(phone)"
    }

    public static func viewerAppError(phoneApp: Bool) -> String {
      phoneApp
        ? "This is the viewer app. View its window from another Stim Desktop instance or your phone."
        : "This is the viewer app. View its window from another Stim Desktop instance."
    }

    public static func notificationRulesPrefix(phoneApp: Bool) -> String {
      phoneApp ? "The same rules as the phone app. " : ""
    }

    public static func recordingFooter(phoneApp: Bool) -> String {
      let replayers = phoneApp ? "Stim Desktop and the phone app replay" : "Stim Desktop replays"
      return
        "recording.enabled on this Mac. While stim-server runs it keeps the last 15 minutes of each simulator, emulator and Chrome page, which \(replayers). A workspace or repository setting still wins. Turning it off deletes the recordings."
    }

  }
}

extension TutorialSteps {
  /// The steps a tutorial shows: without the phone app there is no phone step.
  public static func steps(phoneApp: Bool) -> [TutorialStep] {
    all.filter { $0.id != "phone" || phoneApp }
  }
}
