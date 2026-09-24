/// The shell command that addresses a `stim status` warning, run from the workspace.
///
/// Stim Desktop only shows these commands; it never runs them.
public func remedyCommand(forWarning warning: String, workspace: String) -> String? {
  let command: String
  if warning.contains("stale supervisor record") {
    command = "stim stop"
  } else if warning.contains("not detected by adb") {
    command = "stim android"
  } else {
    return nil
  }
  return "cd \(shellQuote(workspace)) && \(command)"
}

public func warmCommand(worktree: String) -> String {
  "cd \(shellQuote(worktree)) && stim worktree warm"
}

public func shellQuote(_ s: String) -> String {
  "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
