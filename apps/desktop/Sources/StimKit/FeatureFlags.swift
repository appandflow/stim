import Foundation

/// A switch for something Stim Desktop ships but hides by default. Flags are local to this Mac and live in
/// `UserDefaults`; nothing reads them from a server.
public enum FeatureFlag: String, CaseIterable, Identifiable, Sendable {
  /// The phone app: pairing, serving to phones, and every mention of it.
  case phoneApp

  public var id: String { rawValue }

  public var title: String {
    switch self {
    case .phoneApp: return "Phone app"
    }
  }

  public var summary: String {
    switch self {
    case .phoneApp:
      return
        "Shows everything about the Stim phone app: the Phones page with Serve to phones and pairing, the setup guide and tutorial steps, tips and suggestions that mention phones. Turning it off hides them; a running stim-server keeps serving paired phones."
    }
  }

  /// The value on a Mac that has not been seeded and has no override.
  public var defaultValue: Bool {
    switch self {
    case .phoneApp: return false
    }
  }

  /// The user's choice. Absent means the flag follows its default.
  public var overrideKey: String { "featureFlag.\(rawValue)" }

  /// The default decided for this Mac when flags first ran, which differs from `defaultValue` where a feature was
  /// already in use.
  public var seededDefaultKey: String { "featureFlagDefault.\(rawValue)" }
}

public enum FeatureFlags {
  public static let seededKey = "featureFlags.seeded"

  /// Whether `flag` is on: the user's choice, else the default decided for this Mac, else the flag's own default. A
  /// launch argument such as `-featureFlag.phoneApp YES` sets the choice for one run.
  public static func isEnabled(_ flag: FeatureFlag, defaults: UserDefaults = .standard) -> Bool {
    if defaults.object(forKey: flag.overrideKey) != nil { return defaults.bool(forKey: flag.overrideKey) }
    return defaultValue(flag, defaults: defaults)
  }

  public static func defaultValue(_ flag: FeatureFlag, defaults: UserDefaults = .standard) -> Bool {
    if defaults.object(forKey: flag.seededDefaultKey) != nil { return defaults.bool(forKey: flag.seededDefaultKey) }
    return flag.defaultValue
  }

  public static func isOverridden(_ flag: FeatureFlag, defaults: UserDefaults = .standard) -> Bool {
    defaults.object(forKey: flag.overrideKey) != nil
  }

  public static func set(_ flag: FeatureFlag, enabled: Bool, defaults: UserDefaults = .standard) {
    defaults.set(enabled, forKey: flag.overrideKey)
  }

  /// Drops every choice so each flag follows its default again.
  public static func reset(defaults: UserDefaults = .standard) {
    for flag in FeatureFlag.allCases { defaults.removeObject(forKey: flag.overrideKey) }
  }

  /// Decides, once, whether the phone app is on by default: on when this Mac already serves phones or has paired one,
  /// so nothing already in use disappears, off otherwise. `pairedPhones` is nil until stim-server has answered; the
  /// decision waits for the first answer unless `servesPhones` already settles it.
  @discardableResult
  public static func seed(servesPhones: Bool, pairedPhones: Int?, defaults: UserDefaults = .standard) -> Bool {
    guard defaults.object(forKey: seededKey) == nil else { return false }
    if !servesPhones, pairedPhones == nil { return false }
    defaults.set(servesPhones || (pairedPhones ?? 0) > 0, forKey: FeatureFlag.phoneApp.seededDefaultKey)
    defaults.set(true, forKey: seededKey)
    return true
  }
}
