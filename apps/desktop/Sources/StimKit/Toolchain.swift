import Foundation

/// The environment Stim Desktop runs external tools and the engine with: the login shell's, read once, with
/// `STIM_HOME` and other variables from Settings. stimd discovers the toolchain for the commands it runs itself.
public enum Toolchain {
  /// `KEY=VALUE` lines from the environment-overrides setting. Blank lines and lines starting with `#` are skipped,
  /// as is a line without `=` or with an invalid name.
  public static func parseOverrides(_ text: String) -> [String: String] {
    var overrides: [String: String] = [:]
    for raw in text.split(whereSeparator: \.isNewline) {
      let line = raw.trimmingCharacters(in: .whitespaces)
      guard !line.isEmpty, !line.hasPrefix("#"), let equals = line.firstIndex(of: "=") else { continue }
      let name = String(line[..<equals]).trimmingCharacters(in: .whitespaces)
      guard name.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil else { continue }
      overrides[name] = String(line[line.index(after: equals)...]).trimmingCharacters(in: .whitespaces)
    }
    return overrides
  }

  /// The launch environment with the Settings Stim home and environment overrides applied. The Stim home is the
  /// launch `STIM_HOME`, then the setting, then an override's; `~/.stim` is never exported, because an explicit
  /// `STIM_HOME` turns on Stim's scoped-home defaults.
  public static func settingsEnvironment(
    launch: [String: String], stimHome: String?, overrides: String?, home: String = NSHomeDirectory()
  ) -> [String: String] {
    var environment = launch
    let overrides = parseOverrides(overrides ?? "")
    for (name, value) in overrides { environment[name] = value }
    let setting = stimHome.map { $0.hasPrefix("~/") ? home + $0.dropFirst() : $0 }
    let chosen = [launch["STIM_HOME"], setting, overrides["STIM_HOME"]].compactMap { $0 }.first { $0.hasPrefix("/") }
    environment["STIM_HOME"] = chosen.flatMap { StimHome.isDefault($0, home: home) ? nil : $0 }
    return environment
  }

  /// The login shell's environment with Settings applied on top, read once at launch.
  public static func environment(launch: [String: String], stimHome: String?, overrides: String?) async -> [String: String] {
    let base = settingsEnvironment(launch: launch, stimHome: stimHome, overrides: overrides)
    let shell = await LoginShell.environment() ?? LoginShell.fallback(launch)
    await LaunchMilestones.reach("login-environment")
    var environment = shell
    for (name, value) in parseOverrides(overrides ?? "") { environment[name] = value }
    if launch["STIM_HOME"] != nil || !(stimHome ?? "").isEmpty { environment["STIM_HOME"] = base["STIM_HOME"] }
    if let root = base["STIM_ENGINE_ROOT"] { environment["STIM_ENGINE_ROOT"] = root }
    return environment
  }
}
