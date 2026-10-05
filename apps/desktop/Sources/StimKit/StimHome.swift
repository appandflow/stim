import Foundation

public enum StimHome {
  public static func path(environment: [String: String], home: String = NSHomeDirectory()) -> String {
    if let path = absolute(environment["STIM_HOME"]) { return path }
    return "\(home)/.stim"
  }

  public static func isDefault(_ path: String, home: String = NSHomeDirectory()) -> Bool {
    canonical(path) == canonical("\(home)/.stim")
  }

  public static func environment(_ shell: [String: String], launch: [String: String]) -> [String: String] {
    guard let path = absolute(launch["STIM_HOME"]) else { return shell }
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
      "stim-server on port \(port) uses \(abbreviatingHome(serverHome, home: home)), but this Desktop uses \(abbreviatingHome(resolved, home: home)). Stop that server, run it with the same STIM_HOME, or start Stim Desktop with -stimServerPort <port> to use a different port."
  }

  private static func absolute(_ path: String?) -> String? {
    path.flatMap { $0.hasPrefix("/") ? $0 : nil }
  }

  private static func canonical(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().path
  }
}
