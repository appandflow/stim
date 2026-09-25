import Foundation

/// Stim Desktop's own preferences. They live in `UserDefaults`, never in Stim's config.
public enum AppPreferences {
  public enum Key {
    public static let appearance = "appearance"
    public static let showsIdleWorkspaces = "showsIdleWorkspaces"
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

    public static func notifies(_ kind: StatusEvent.Kind) -> String { "notify.\(kind.rawValue)" }
  }

  public static let frameRates: [Double] = [60, 30, 15, 5]

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
