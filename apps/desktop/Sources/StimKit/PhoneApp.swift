import Foundation

/// What the phone app flag decides, one function per place that shows something about phones. A view asks here
/// instead of testing the flag itself, so each entry point has one tested answer.
public enum PhoneApp {
  /// The settings page that holds stim-server's controls.
  public struct ServerPage: Equatable, Sendable {
    public var title: String
    public var systemImage: String
    /// The label of the switch that runs stim-server, which Desktop also uses for replay, the diff viewer and
    /// Macs approved to build or host devices here.
    public var serveToggleTitle: String
  }

  public static func serverPage(phoneApp: Bool) -> ServerPage {
    phoneApp
      ? ServerPage(
        title: "Phones", systemImage: "iphone.gen3.radiowaves.left.and.right", serveToggleTitle: "Serve to phones")
      : ServerPage(
        title: "Server", systemImage: "server.rack", serveToggleTitle: "Run stim-server")
  }

  /// The sidebar footer button that shows the phone server's state and opens the Phones page.
  public static func showsSidebarButton(phoneApp: Bool, servesPhones: Bool) -> Bool { phoneApp && servesPhones }

  /// Whether the server Desktop starts also listens on this Mac's Tailscale addresses. Only the phone app serving
  /// phones asks for it; every other run listens on loopback alone.
  public static func listensOnTailnet(phoneApp: Bool, servesPhones: Bool) -> Bool { phoneApp && servesPhones }

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

    public static func viewerAppError(phoneApp: Bool) -> String {
      phoneApp
        ? "This is the viewer app. View its window from another Stim Desktop instance or your phone."
        : "This is the viewer app. View its window from another Stim Desktop instance."
    }

    public static func notificationRulesPrefix(phoneApp: Bool) -> String {
      phoneApp ? "The same rules as the phone app. " : ""
    }

    public static func serverPageName(phoneApp: Bool) -> String { phoneApp ? "Phones" : "Server" }

    /// Who connects to stim-server over Tailscale.
    public static func clients(phoneApp: Bool) -> String { phoneApp ? "Phones" : "Other Macs" }

    public static func tailscaleDown(phoneApp: Bool) -> String {
      phoneApp
        ? "Phones cannot connect until Tailscale runs. Only a client on this Mac, such as an iOS Simulator, can pair now."
        : "Other Macs cannot connect until Tailscale runs. Only a client on this Mac can connect now."
    }

    public static func recordingFooter(phoneApp: Bool) -> String {
      let replayers = phoneApp ? "Stim Desktop and the phone app replay" : "Stim Desktop replays"
      return
        "recording.enabled on this Mac. While stim-server runs it keeps the last 15 minutes of each simulator, emulator and Chrome page, which \(replayers). A workspace or repository setting still wins. Turning it off deletes the recordings."
    }

    public static func serverPopupTitle(missing: Bool, phoneApp: Bool) -> String {
      let action = missing ? "Install" : "Update"
      return phoneApp ? "\(action) stim-server to serve phones" : "\(action) stim-server"
    }

    public static func serverPopupDetail(minimum: String, phoneApp: Bool) -> String {
      let subject =
        phoneApp
        ? "stim-server shares Stim's status with paired phones"
        : "stim-server serves device replay, the diff viewer and archived logs"
      return "\(subject), and Stim Desktop needs \(minimum) or later."
    }

  }
}

extension TutorialSteps {
  /// The steps a tutorial shows: without the phone app there is no phone step.
  public static func steps(phoneApp: Bool) -> [TutorialStep] {
    all.filter { $0.id != "phone" || phoneApp }
  }
}
