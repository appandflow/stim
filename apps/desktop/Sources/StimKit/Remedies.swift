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

/// `stim web` with the running browser's launch options, which it reuses; a different `--headed` restarts Chrome.
private func webCommand(_ browser: WebBrowser, cwd: String) -> StimCommand {
  StimCommand(browser.headless ? ["web"] : ["web", "--headed"], cwd: cwd)
}

/// `1 error`, `2 errors`: the count with the noun made plural when it is not one.
public func countLabel(_ count: Int, _ noun: String, plural: String? = nil) -> String {
  "\(count.formatted()) \(count == 1 ? noun : plural ?? noun + "s")"
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
  case .web:
    return StimCommand(["stop", "--slot", DeviceRef.webSlot], cwd: cwd)
  }
}

public func shellQuote(_ s: String) -> String {
  "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

/// The `stim ios` or `stim android` command that builds if needed, installs and launches the app on one
/// Stim-owned simulator or emulator, naming its slot unless it is the default one, or `stim web` for the
/// workspace's Chrome. Nil for a physical device or one Stim does not own, which that command does not target.
public func runCommand(for device: DeviceRef, cwd: String) -> StimCommand? {
  switch device {
  case .ios(_, let sim) where sim.owned || sim.host != nil: break
  case .android(_, let avd) where (avd.owned || avd.host != nil) && !avd.physical: break
  case .web(let browser): return webCommand(browser, cwd: cwd)
  default: return nil
  }
  let slot = device.slot == DeviceRef.defaultSlot ? [] : ["--slot", device.slot]
  let remote = device.hostedMachine.map { ["--remote", $0] } ?? []
  return StimCommand([device.platform] + slot + remote, cwd: cwd)
}
