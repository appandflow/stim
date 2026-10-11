import Foundation

/// What the last launch's login environment resolved for stim-server, so Desktop can start the server before this
/// launch's login shell returns. It holds the executable and an allowlist of non-secret variables, never a
/// secret-named one. A server started from it is provisional, with reads only, until `verifies` confirms that the
/// login environment resolves the same executable and variables.
public struct ProvisionalServerStart: Codable, Equatable, Sendable {
  public var executable: String
  public var environment: [String: String]

  public init(executable: String, environment: [String: String]) {
    self.executable = executable
    self.environment = environment
  }

  private static let carriedNames: Set = [
    "PATH", "HOME", "STIM_HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "JAVA_HOME", "GRADLE_USER_HOME", "DEVELOPER_DIR",
  ]
  private static let carriedPrefixes = ["STIM_", "ANDROID_", "NODE_"]
  private static let secretMarkers = ["TOKEN", "SECRET", "PASS", "KEY", "AUTH", "CREDENTIAL", "PRIVATE"]

  /// The variables stim-server and the tools it runs read from the login environment. `STIM_DESKTOP_APP`,
  /// `STIM_RUN_ID` and `STIM_BACKGROUND_LAUNCH` describe this launch of the app, not the login environment.
  static func carried(_ environment: [String: String]) -> [String: String] {
    environment.filter { name, _ in
      !["STIM_DESKTOP_APP", "STIM_RUN_ID", "STIM_BACKGROUND_LAUNCH"].contains(name)
        && (carriedNames.contains(name) || carriedPrefixes.contains { name.hasPrefix($0) })
    }
  }

  static func isSecret(_ name: String) -> Bool {
    secretMarkers.contains { name.contains($0) }
  }

  /// What to remember from `environment`, the one the server starts with once the login environment arrives. Nil
  /// when no stim-server resolves, or when a carried variable is secret-named: it is never stored, so a start without
  /// it could not match.
  public static func remembering(environment: [String: String], override: String?) -> ProvisionalServerStart? {
    let carried = carried(environment)
    guard !carried.keys.contains(where: isSecret),
      let executable = StimServerCLI(environment: environment, override: override).executable
    else { return nil }
    return ProvisionalServerStart(executable: executable, environment: carried)
  }

  /// The environment to start the server with before the login environment arrives: `launch` with the remembered
  /// variables, keeping the launch's own `STIM_HOME` as `StimHome.environment` does. Nil when the remembered
  /// executable no longer exists or is not the one that resolves now, as after a changed override.
  public func environment(launch: [String: String], override: String?) -> [String: String]? {
    let environment = StimHome.environment(launch.merging(self.environment) { $1 }, launch: launch)
    guard FileManager.default.isExecutableFile(atPath: executable),
      StimServerCLI(environment: environment, override: override).executable == executable
    else { return nil }
    return environment
  }

  /// Whether a server started from `executable` with `started` is the one Desktop would start with `login`, the
  /// environment it has once the login shell returns: the same executable, and the same carried variables, which
  /// include `STIM_HOME`. stim-server runs the `stim` it bundles, so the executable decides both versions.
  public static func verifies(
    executable: String, started: [String: String], login: [String: String], override: String?
  ) -> Bool {
    let carried = carried(login)
    return !carried.keys.contains(where: isSecret) && carried == Self.carried(started)
      && StimServerCLI(environment: login, override: override).executable == executable
  }
}
