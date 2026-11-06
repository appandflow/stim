import Darwin
import Foundation

public enum StimHome {
  static func isPrivateLocalSocket(directory: stat, socket: stat) -> Bool {
    directory.st_mode & S_IFMT == S_IFDIR && socket.st_mode & S_IFMT == S_IFSOCK
      && directory.st_uid == getuid() && socket.st_uid == getuid()
      && directory.st_mode & 0o077 == 0 && socket.st_mode & 0o077 == 0
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

  private static func absolute(_ path: String?) -> String? {
    path.flatMap { $0.hasPrefix("/") ? $0 : nil }
  }

  private static func canonical(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().path
  }
}
