import Foundation

/// The environment Stim Desktop runs Stim with. It never runs a login shell when the app carries the bundled
/// server: Stim's own toolchain discovery, the one stim-server uses, fills in `PATH`, `ANDROID_HOME` and
/// `JAVA_HOME`, and `STIM_HOME` and other variables come from Settings.
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

  /// `base` with the toolchain the bundled Node's `discoverToolchain` finds, or nil when it fails.
  public static func discover(base: [String: String], bundled: BundledServer) async -> [String: String]? {
    let script =
      "import { discoverToolchain } from '@stim-cli/core/toolchain';"
      + "process.stdout.write(JSON.stringify(discoverToolchain(process.env).env));"
    var request = ProcessRequest(
      bundled.node, ["--input-type=module", "-e", script], cwd: bundled.root, environment: base, timeout: 5)
    request.captureStderr = true
    guard let result = try? await request.run(), result.succeeded,
      let environment = try? JSONDecoder().decode([String: String].self, from: result.stdout)
    else { return nil }
    return environment
  }

  /// The environment for Stim commands: discovery through the bundled server's Node, or, in a build without it,
  /// the login shell's environment with Settings applied on top.
  public static func environment(
    launch: [String: String], stimHome: String?, overrides: String?, bundled: BundledServer? = BundledServer.inApp()
  ) async -> [String: String] {
    let base = settingsEnvironment(launch: launch, stimHome: stimHome, overrides: overrides)
    if let bundled, let discovered = await discover(base: base, bundled: bundled) {
      await LaunchMilestones.reach("toolchain-environment")
      return discovered
    }
    DebugLog.warning(
      .app,
      bundled == nil
        ? "this build carries no bundled stim-server, so the environment comes from the login shell"
        : "the bundled toolchain discovery failed, so the environment comes from the login shell")
    let shell = await LoginShell.environment() ?? LoginShell.fallback(launch)
    await LaunchMilestones.reach("login-environment")
    var environment = shell
    for (name, value) in parseOverrides(overrides ?? "") { environment[name] = value }
    if let path = base["STIM_HOME"] { environment["STIM_HOME"] = path }
    return environment
  }
}
