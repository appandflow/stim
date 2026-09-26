import Foundation

/// Stim Desktop's own preferences. They live in `UserDefaults`, never in Stim's config.
public enum AppPreferences {
  public enum Key {
    public static let appearance = "appearance"
    public static let showsIdleWorkspaces = "showsIdleWorkspaces"
    public static let hidesUnprovisionedWorktrees = "hidesUnprovisionedWorktrees"
    public static let sidebarStatus = "sidebar.status"
    public static let hiddenProjects = "sidebar.hiddenProjects"
    public static let sidebarGrouping = "sidebar.grouping"
    public static let sidebarSort = "sidebar.sort"
    public static let showsGitStatus = "sidebar.showsGitStatus"
    public static let showsEmptyProjects = "sidebar.showsEmptyProjects"
    public static let expandedProjects = "sidebar.expandedProjects"
    public static let defaultView = "defaultView"
    public static let lastProjectPath = "lastProjectPath"
    public static let tileSize = "tileSize"
    public static let maxFramesPerSecond = "maxFramesPerSecond"
    public static let pausesHiddenFrames = "pausesHiddenFrames"
    public static let editorBundleID = "editorBundleID"
    public static let terminalBundleID = "terminalBundleID"
    public static let showsMenuBarExtra = "showsMenuBarExtra"
    public static let stimExecutable = "stimExecutable"
    public static let remoteSessionMinutes = "remoteSessionMinutes"
    public static let autopilotIdleShutdown = "autopilot.idleShutdown"
    public static let autopilotIdleMinutes = "autopilot.idleMinutes"
    public static let autopilotNightly = "autopilot.nightly"
    public static let autopilotNightlyHour = "autopilot.nightlyHour"
    public static let autopilotNightlyOlderThanDays = "autopilot.nightlyOlderThanDays"
    public static let autopilotPressure = "autopilot.pressure"
    public static let autopilotPullRequests = "autopilot.pullRequests"
    public static let autopilotLastNightly = "autopilot.lastNightly"
    public static let autopilotLog = "autopilot.log"
    public static let notifiesDiskPressure = "notify.diskPressure"
    public static let notifiesWorktreeRemoval = "notify.worktreeRemoval"
    public static let servesPhones = "servesPhones"
    public static let stimServerExecutable = "stimServerExecutable"
    public static let showsInspector = "showsInspector"
    public static let viewerOfferDismissed = "onboarding.viewerOfferDismissed"

    public static func notifies(_ kind: StatusEvent.Kind) -> String { "notify.\(kind.rawValue)" }
  }

  public static let frameRates: [Double] = [60, 30, 15, 5]

  /// Autopilot is on by default: idle devices shut down after an hour, a cleanup of what has gone unused for
  /// 7 days runs at 3:00, disk pressure is acted on, and worktrees whose pull request finished are removed when
  /// `stim gc` finds nothing in them would be lost.
  public static var defaults: [String: Any] {
    [
      Key.autopilotIdleShutdown: true,
      Key.autopilotIdleMinutes: 60,
      Key.autopilotNightly: true,
      Key.autopilotNightlyHour: 3,
      Key.autopilotNightlyOlderThanDays: 7,
      Key.autopilotPressure: true,
      Key.autopilotPullRequests: true,
      Key.notifiesDiskPressure: true,
      Key.notifiesWorktreeRemoval: true,
      Key.showsInspector: true,
    ]
  }

  /// Carries the retired "Show idle workspaces" switch over to the sidebar's Status option.
  public static func migrate(_ defaults: UserDefaults) {
    guard let showsIdle = defaults.object(forKey: Key.showsIdleWorkspaces) as? Bool else { return }
    if !showsIdle, defaults.string(forKey: Key.sidebarStatus) == nil {
      defaults.set(StatusFilter.live.rawValue, forKey: Key.sidebarStatus)
    }
    defaults.removeObject(forKey: Key.showsIdleWorkspaces)
  }

  public static let idleMinuteChoices = [30, 60, 120, 240]
  public static let nightlyOlderThanDayChoices = [1, 3, 7, 14, 30]

  /// The live-frame cap the simulator and emulator views read on every frame.
  public static var maxFramesPerSecond: Double {
    let value = UserDefaults.standard.double(forKey: Key.maxFramesPerSecond)
    return value > 0 ? value : 60
  }

  public static var pausesHiddenFrames: Bool {
    UserDefaults.standard.object(forKey: Key.pausesHiddenFrames) as? Bool ?? true
  }
}

public enum Appearance: String, CaseIterable, Sendable {
  case auto, light, dark

  public var title: String {
    switch self {
    case .auto: return "Auto"
    case .light: return "Light"
    case .dark: return "Dark"
    }
  }
}

public enum DefaultView: String, CaseIterable, Sendable {
  case allDevices, lastProject

  public var title: String {
    switch self {
    case .allDevices: return "All devices"
    case .lastProject: return "Last project"
    }
  }
}

public enum TileSize: String, CaseIterable, Sendable {
  case small, medium, large

  public var title: String { rawValue.capitalized }

  public var screenHeight: Double {
    switch self {
    case .small: return 300
    case .medium: return 400
    case .large: return 540
    }
  }
}

/// An app Stim Desktop can hand a workspace directory to.
public struct ExternalApp: Hashable, Identifiable, Sendable {
  public var name: String
  public var bundleID: String

  public var id: String { bundleID }

  public static let editors: [ExternalApp] = [
    ExternalApp(name: "Visual Studio Code", bundleID: "com.microsoft.VSCode"),
    ExternalApp(name: "Cursor", bundleID: "com.todesktop.230313mzl4w4u92"),
    ExternalApp(name: "Xcode", bundleID: "com.apple.dt.Xcode"),
    ExternalApp(name: "Zed", bundleID: "dev.zed.Zed"),
  ]

  public static let terminals: [ExternalApp] = [
    ExternalApp(name: "Terminal", bundleID: "com.apple.Terminal"),
    ExternalApp(name: "iTerm", bundleID: "com.googlecode.iterm2"),
    ExternalApp(name: "Ghostty", bundleID: "com.mitchellh.ghostty"),
    ExternalApp(name: "Warp", bundleID: "dev.warp.Warp-Stable"),
  ]

  /// The preferred app when it is installed, otherwise the first installed one.
  public static func choose(
    _ preferred: String?, from apps: [ExternalApp], isInstalled: (String) -> Bool
  ) -> ExternalApp? {
    let installed = apps.filter { isInstalled($0.bundleID) }
    return installed.first { $0.bundleID == preferred } ?? installed.first
  }
}
