import CryptoKit
import Darwin
import Foundation

public enum StimHome {
  /// The local socket for the Stim home reported by the server. macOS sun_path has
  /// 103 usable UTF-8 bytes; longer paths use the socket path's SHA-256 under /tmp.
  public static func localSocket(home: String) -> URL {
    var components: [Substring] = []
    for component in (home + "/server/local.sock").split(separator: "/") {
      if component == "." { continue }
      if component == ".." {
        if !components.isEmpty { components.removeLast() }
      } else {
        components.append(component)
      }
    }
    let path = "/" + components.joined(separator: "/")
    guard path.utf8.count > 103 else { return URL(fileURLWithPath: path) }
    let digest = SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
    return URL(fileURLWithPath: "/tmp/stim-sockets-\(getuid())/\(digest).sock")
  }

  public static func path(environment: [String: String], home: String = NSHomeDirectory()) -> String {
    if let path = absolute(environment["STIM_HOME"]) { return path }
    return "\(home)/.stim"
  }

  /// Whether two paths name the same Stim home once symbolic links are resolved.
  public static func isSame(_ a: String, _ b: String) -> Bool {
    canonical(a) == canonical(b)
  }

  public static func isDefault(_ path: String, home: String = NSHomeDirectory()) -> Bool {
    canonical(path) == canonical("\(home)/.stim")
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
