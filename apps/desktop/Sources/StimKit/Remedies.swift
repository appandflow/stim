import Foundation

/// A `stim` invocation: its arguments and the directory it runs in.
public struct StimCommand: Hashable, Sendable {
  public var arguments: [String]
  public var cwd: String

  public init(_ arguments: [String], cwd: String) {
    self.arguments = arguments
    self.cwd = cwd
  }

  /// The same command as one line for a shell, for copying.
  public var shellLine: String {
    (["cd", shellQuote(cwd), "&&", "stim"] + arguments).joined(separator: " ")
  }

  /// `shellLine` with paths under `home` written from `~`, still valid for a shell.
  public func displayLine(home: String = NSHomeDirectory()) -> String {
    func relative(_ path: String) -> String? {
      path == home ? "" : path.hasPrefix(home + "/") ? String(path.dropFirst(home.count + 1)) : nil
    }
    let dir = relative(cwd).map { $0.isEmpty ? "~" : "~/" + shellQuote($0) } ?? shellQuote(cwd)
    let arguments = arguments.map { argument in relative(argument).map { $0.isEmpty ? "~" : "~/" + $0 } ?? argument }
    return (["cd", dir, "&&", "stim"] + arguments).joined(separator: " ")
  }
}

/// The command that addresses a `stim status` warning, run from the workspace.
public func remedyCommand(forWarning warning: String, workspace: String) -> StimCommand? {
  if warning.contains("stale supervisor record") {
    return StimCommand(["stop"], cwd: workspace)
  }
  if warning.contains("not detected by adb") {
    return StimCommand(["android"], cwd: workspace)
  }
  return nil
}

/// The commands that create an environment for a worktree Stim has not registered.
public func environmentCommands(worktree: String) -> [StimCommand] {
  [["start"], ["ios"], ["android"]].map { StimCommand($0, cwd: worktree) }
}

public func shellQuote(_ s: String) -> String {
  "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
