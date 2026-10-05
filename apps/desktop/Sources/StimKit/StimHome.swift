import Foundation

public enum StimHome {
  public static func path(environment: [String: String], home: String = NSHomeDirectory()) -> String {
    if let path = environment["STIM_HOME"], !path.isEmpty { return path }
    return "\(home)/.stim"
  }

  public static func isDefault(_ path: String, home: String = NSHomeDirectory()) -> Bool {
    canonical(path) == canonical("\(home)/.stim")
  }

  public static func environment(_ shell: [String: String], launch: [String: String]) -> [String: String] {
    guard let path = launch["STIM_HOME"], !path.isEmpty else { return shell }
    var environment = shell
    environment["STIM_HOME"] = path
    return environment
  }

  public static func adopts(serverHome: String, resolved: String, home: String = NSHomeDirectory()) -> Bool {
    isDefault(resolved, home: home) || canonical(serverHome) == canonical(resolved)
  }

  public static func adoptionFailure(
    serverHome: String, resolved: String, port: Int, home: String = NSHomeDirectory()
  ) -> String? {
    guard !adopts(serverHome: serverHome, resolved: resolved, home: home) else { return nil }
    return
      "stim-server on port \(port) uses \(abbreviatingHome(serverHome, home: home)), but this Desktop uses \(abbreviatingHome(resolved, home: home)). Stop that server or start Stim Desktop with -stimServerPort <port> to use a different port."
  }

  private static func canonical(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().path
  }
}
