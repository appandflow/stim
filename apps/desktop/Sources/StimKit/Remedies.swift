import Foundation

/// A `stim` invocation: its arguments and the directory it runs in.
public struct StimCommand: Hashable, Sendable {
  public var arguments: [String]
  public var cwd: String
  /// The program the command runs: `stim`, or another tool found on the `stim` environment's `PATH`.
  public var program: String

  public init(_ arguments: [String], cwd: String, program: String = "stim") {
    self.arguments = arguments
    self.cwd = cwd
    self.program = program
  }

  /// The same command as one line for a shell, for copying.
  public var shellLine: String {
    (["cd", shellQuote(cwd), "&&", program] + arguments).joined(separator: " ")
  }

  /// `shellLine` with paths under `home` written from `~`, still valid for a shell.
  public func displayLine(home: String = NSHomeDirectory()) -> String {
    func relative(_ path: String) -> String? {
      path == home ? "" : path.hasPrefix(home + "/") ? String(path.dropFirst(home.count + 1)) : nil
    }
    let dir = relative(cwd).map { $0.isEmpty ? "~" : "~/" + shellQuote($0) } ?? shellQuote(cwd)
    let arguments = arguments.map { argument in relative(argument).map { $0.isEmpty ? "~" : "~/" + $0 } ?? argument }
    return (["cd", dir, "&&", program] + arguments).joined(separator: " ")
  }
}

/// The command that addresses a `stim status` warning from a `stim` that reports no `issues`, run from the workspace.
public func remedyCommand(forWarning warning: String, workspace: String) -> StimCommand? {
  if warning.contains("stale supervisor record") {
    return StimCommand(["stop"], cwd: workspace)
  }
  if warning.contains("not detected by adb") {
    return StimCommand(["android"], cwd: workspace)
  }
  return nil
}

public struct AttentionItem: Hashable, Sendable {
  public var text: String
  public var isError: Bool
  /// The remedy, run from the workspace; nil when none is known.
  public var command: StimCommand?
  /// False for a remedy that only explains, such as a `stim guide` topic.
  public var runnable: Bool
}

public struct AttentionGroup: Hashable, Sendable {
  public var workspace: Workspace
  public var items: [AttentionItem]
}

/// The workspaces with something to fix: live ones first, then those with an error, each in status order. Items
/// come from `issues`, or from the `warnings` text when `stim` reports no issues.
public func attentionGroups(_ workspaces: [Workspace]) -> [AttentionGroup] {
  let groups = workspaces.compactMap { env -> AttentionGroup? in
    let items: [AttentionItem]
    if let issues = env.issues {
      items = issues.map { issue in
        let words = issue.remedy.split(separator: " ").map(String.init)
        let command = words.first == "stim" ? StimCommand(Array(words.dropFirst()), cwd: issue.workspace) : nil
        return AttentionItem(
          text: issue.slot.map { "\($0): \(issue.message)" } ?? issue.message,
          isError: issue.severity == "error",
          command: command,
          runnable: command != nil && words.dropFirst().first != "guide")
      }
    } else {
      items = env.warnings.map { warning in
        let command = remedyCommand(forWarning: warning, workspace: env.path)
        return AttentionItem(text: warning, isError: false, command: command, runnable: command != nil)
      }
    }
    return items.isEmpty ? nil : AttentionGroup(workspace: env, items: items)
  }
  func rank(_ group: AttentionGroup) -> Int {
    (group.workspace.live ? 0 : 2) + (group.items.contains(where: \.isError) ? 0 : 1)
  }
  return groups.enumerated().sorted { a, b in
    rank(a.element) != rank(b.element) ? rank(a.element) < rank(b.element) : a.offset < b.offset
  }.map(\.element)
}

/// The commands that create an environment for a worktree Stim has not registered.
public func environmentCommands(worktree: String) -> [StimCommand] {
  [["start"], ["ios"], ["android"]].map { StimCommand($0, cwd: worktree) }
}

/// The `stim stop` command that stops one device. A remote session has no per-slot
/// teardown, so it runs plain `stop`, which ends the whole workspace including the session.
public func stopCommand(for device: DeviceRef, cwd: String) -> StimCommand {
  switch device {
  case .ios(let slot, _), .android(let slot, _):
    return StimCommand(["stop", "--slot", slot], cwd: cwd)
  case .remote:
    return StimCommand(["stop"], cwd: cwd)
  }
}

public func shellQuote(_ s: String) -> String {
  "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
