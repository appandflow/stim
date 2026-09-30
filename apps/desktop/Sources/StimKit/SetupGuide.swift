import Foundation

/// The screens of Stim Desktop's first-run setup guide, in order.
public enum SetupStep: String, CaseIterable, Sendable {
  case welcome, cli, skill, notifications, check, done

  public var title: String {
    switch self {
    case .welcome: return "Welcome"
    case .cli: return "Install the CLI"
    case .skill: return "Add the agent skill"
    case .notifications: return "Notifications"
    case .check: return "Check your setup"
    case .done: return "You're set"
    }
  }

  public var next: SetupStep? {
    let all = Self.allCases
    return all.firstIndex(of: self).flatMap { $0 + 1 < all.count ? all[$0 + 1] : nil }
  }

  public var previous: SetupStep? {
    let all = Self.allCases
    return all.firstIndex(of: self).flatMap { $0 > 0 ? all[$0 - 1] : nil }
  }
}

/// Whether macOS lets Stim Desktop post notifications.
public enum NotificationAccess: Sendable {
  /// No app bundle, as under `swift run`, so there is nothing to ask for.
  case unavailable
  case notDetermined
  case denied
  case allowed
}

public enum SetupStepState: Equatable, Sendable {
  case checking
  case done
  case pending
  /// Needs something the guide cannot do itself: Node.js for the CLI, System Settings for denied notifications.
  case blocked
  /// Nothing to do on this Mac or build.
  case notApplicable
}

/// What the setup guide found on this Mac. A nil field has not been checked yet.
public struct SetupChecks: Equatable, Sendable {
  /// `engines.node` of the `stim` package.
  public static let nodeMinimum = SemanticVersion("22.12.0")!
  /// The skill id `npx skills add appandflow/stim` installs.
  public static let skillName = "stim"

  public var stim: CLICompatibility?
  public var node: CLICompatibility?
  /// Homebrew's `brew`, which can install Node.js, when it is on the login shell's PATH.
  public var brewPath: String?
  /// The installed skill's `SKILL.md`, or nil when none was found.
  public var skillPath: String?
  public var skillChecked = false
  public var notifications: NotificationAccess?

  public init(
    stim: CLICompatibility? = nil, node: CLICompatibility? = nil, brewPath: String? = nil, skillPath: String? = nil,
    skillChecked: Bool = false, notifications: NotificationAccess? = nil
  ) {
    self.stim = stim
    self.node = node
    self.brewPath = brewPath
    self.skillPath = skillPath
    self.skillChecked = skillChecked
    self.notifications = notifications
  }

  public func state(of step: SetupStep) -> SetupStepState {
    switch step {
    case .welcome, .done:
      return .notApplicable
    case .cli:
      guard let stim else { return .checking }
      if stim.isCompatible { return .done }
      guard let node else { return .checking }
      return node.isCompatible ? .pending : .blocked
    case .skill:
      guard skillChecked else { return .checking }
      return skillPath == nil ? .pending : .done
    case .notifications:
      switch notifications {
      case nil: return .checking
      case .unavailable: return .notApplicable
      case .notDetermined: return .pending
      case .denied: return .blocked
      case .allowed: return .done
      }
    case .check:
      return .notApplicable
    }
  }

  /// Every step the guide can finish on its own is done: the CLI, the skill and notifications. The checks of this
  /// Mac and of a project stay optional.
  public var isComplete: Bool {
    [SetupStep.cli, .skill, .notifications].allSatisfy {
      let state = state(of: $0)
      return state == .done || state == .notApplicable
    }
  }

  /// The screen the guide opens on: a step saved before a restart, else the summary when nothing is left to do,
  /// else the welcome.
  public func startStep(resuming saved: SetupStep?) -> SetupStep {
    if let saved { return saved }
    return isComplete ? .done : .welcome
  }

  /// Where the skills CLI puts the skill, relative to the home directory: the shared `.agents` copy it links into
  /// each agent, then the Claude Code and Codex folders, which a `--copy` install writes to directly.
  public static let skillLocations = [
    ".agents/skills/\(skillName)/SKILL.md",
    ".claude/skills/\(skillName)/SKILL.md",
    ".codex/skills/\(skillName)/SKILL.md",
  ]

  /// The first installed `SKILL.md` under `home`, following symbolic links.
  public static func installedSkill(home: String, exists: (String) -> Bool) -> String? {
    skillLocations.lazy.map { "\(home)/\($0)" }.first(where: exists)
  }
}

extension SetupChecks {
  /// The first `name` on `environment`'s PATH.
  public static func tool(_ name: String, environment: [String: String]) -> String? {
    var environment = environment
    return resolveExecutable(name, override: nil, environment: &environment)
  }

  /// `name --version` from `environment`'s PATH: the executable, and what it printed, nil when it failed.
  public static func version(of name: String, environment: [String: String]) async -> (path: String?, output: String?) {
    var environment = environment
    guard let path = resolveExecutable(name, override: nil, environment: &environment) else { return (nil, nil) }
    let result = try? await ProcessRequest(path, ["--version"], environment: environment, timeout: 10).run()
    return (path, result.flatMap { $0.succeeded ? $0.stdoutText : nil })
  }
}

/// Reads the output of the read-only commands the guide runs to check this Mac's build tools.
public enum MachineCheck {
  /// `Xcode 26.0` from `xcodebuild -version`.
  public static func xcode(_ output: String) -> String? {
    output.split(whereSeparator: \.isNewline).first { $0.hasPrefix("Xcode ") }.map(String.init)
  }

  /// `17.0.12` from `java -version`, which prints `openjdk version "17.0.12" 2024-07-16` to stderr.
  public static func java(_ output: String) -> String? {
    guard let line = output.split(whereSeparator: \.isNewline).first(where: { $0.contains(" version \"") }) else {
      return nil
    }
    return line.split(separator: "\"").dropFirst().first.map(String.init)
  }

  /// The Android SDK the way `stim` finds it: `ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then the Android Studio
  /// default, when that directory exists.
  public static func androidSDK(environment: [String: String], home: String, exists: (String) -> Bool) -> String? {
    for name in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
      if let path = environment[name], !path.isEmpty { return exists(path) ? path : nil }
    }
    let path = "\(home)/Library/Android/sdk"
    return exists(path) ? path : nil
  }
}

/// Whether the guide opens by itself at launch, and the screen to reopen after a restart. Kept in the app's own
/// `UserDefaults`, so Stim and Stim Dev, which have separate bundle ids, each track their own.
public struct SetupGuideProgress {
  public static let completedKey = "setupGuide.completed"
  public static let resumeKey = "setupGuide.resumeStep"

  private let defaults: UserDefaults

  public init(_ defaults: UserDefaults = .standard) {
    self.defaults = defaults
  }

  /// The guide opens by itself until it is finished or closed once, or when a restart saved a step to return to.
  public var opensAtLaunch: Bool { !defaults.bool(forKey: Self.completedKey) || resumeStep != nil }

  public var resumeStep: SetupStep? {
    defaults.string(forKey: Self.resumeKey).flatMap(SetupStep.init(rawValue:))
  }

  /// Saves `step` to reopen on after Stim Desktop restarts.
  public func saveForRestart(at step: SetupStep) {
    defaults.set(step.rawValue, forKey: Self.resumeKey)
  }

  /// Forgets the saved step once the guide has reopened on it.
  public func resumed() {
    defaults.removeObject(forKey: Self.resumeKey)
  }

  public func finish() {
    defaults.set(true, forKey: Self.completedKey)
    defaults.removeObject(forKey: Self.resumeKey)
  }
}
