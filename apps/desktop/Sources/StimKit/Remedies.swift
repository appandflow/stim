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

public func warmCommand(worktree: String) -> StimCommand {
  StimCommand(["worktree", "warm"], cwd: worktree)
}

public func shellQuote(_ s: String) -> String {
  "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
