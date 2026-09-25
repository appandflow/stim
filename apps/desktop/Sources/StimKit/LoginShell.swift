import Foundation

/// The environment of the user's login shell. An app launched from Finder gets
/// launchd's environment instead, without the PATH entries and variables such
/// as `ANDROID_HOME` that the shell profile sets.
public enum LoginShell {
  /// Runs `zsh -lic` once and returns the environment it exports, or nil when
  /// the shell fails to report one or has not exited after `timeout`. The shell
  /// writes to a file rather than a pipe because a background process started
  /// by a profile can keep a pipe open after the shell exits.
  public static func environment(shell: String = "/bin/zsh", timeout: TimeInterval = 10) async -> [String: String]? {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("stim-login-env-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: file) }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: shell)
    process.arguments = ["-lic", "command env -0 > \"$1\"", "zsh", file.path]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      process.terminationHandler = { _ in done.resume() }
      do {
        try process.run()
        // An interactive zsh ignores SIGTERM, so only SIGKILL stops a profile that never returns.
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
          if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
      } catch {
        process.terminationHandler = nil
        done.resume()
      }
    }
    guard process.terminationReason == .exit, let data = try? Data(contentsOf: file) else { return nil }
    let environment = parseEnvironment(data)
    return environment.isEmpty ? nil : environment
  }

  /// `environment` with the Homebrew and system directories on `PATH`, for when
  /// the login shell reports nothing: launchd's `PATH` holds only system directories.
  public static func fallback(_ environment: [String: String]) -> [String: String] {
    let preferred = ["/opt/homebrew/bin", "/usr/local/bin"]
    let system = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    let current = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
    var path = preferred + current.filter { !preferred.contains($0) }
    path += system.filter { !path.contains($0) }
    var environment = environment
    environment["PATH"] = path.joined(separator: ":")
    return environment
  }

  /// Parses `env -0` output: `NAME=value` entries, each ending in a NUL byte.
  /// A value can contain `=` and newlines.
  static func parseEnvironment(_ data: Data) -> [String: String] {
    var environment: [String: String] = [:]
    for entry in data.split(separator: 0) {
      guard let equals = entry.firstIndex(of: UInt8(ascii: "=")), equals > entry.startIndex else { continue }
      let name = String(decoding: entry[entry.startIndex..<equals], as: UTF8.self)
      environment[name] = String(decoding: entry[(equals + 1)...], as: UTF8.self)
    }
    return environment
  }
}
