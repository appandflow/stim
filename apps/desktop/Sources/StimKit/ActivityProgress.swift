import Foundation

/// One row of an action sheet's step list, built by parsing the phase lines the CLI
/// prints for a long-running command (`stim guide lifecycle progress`): two spaces, a
/// label, a fact, and an optional trailing `(<duration>)`.
public struct ProgressStep: Hashable, Sendable, Identifiable {
  public enum State: Hashable, Sendable {
    case running
    case waiting
    case done
    case failed
  }

  public var id: String { label }
  /// The phase label as the CLI prints it, e.g. "device", "stop", "build".
  public var label: String
  /// The fact after the label, with any trailing duration removed.
  public var fact: String
  /// The trailing `(<duration>)` the CLI printed, when present.
  public var duration: String?
  public var state: State

  /// The action sheet's primary status, with launch identifiers kept in command output.
  public var statusText: String {
    switch label {
    case "launch": return "Launching app"
    case "verify": return "Verifying launch"
    default: return fact.isEmpty ? label : fact
    }
  }

  public init(label: String, fact: String, duration: String?, state: State) {
    self.label = label
    self.fact = fact
    self.duration = duration
    self.state = state
  }
}

/// Parses the CLI's phase-line progress output into step rows for the action sheet.
public enum ActivityProgress {
  private static let phaseLine = try! NSRegularExpression(pattern: "^  (\\S+)\\s+(\\S.*)$")

  /// The CLI's closed set of progress labels (`OUTPUT_LABELS` in packages/stim-cli/src/command-output.ts).
  /// Other indented lines, such as the rows of a `gc` report, are not progress.
  public static let labels: Set<String> = [
    "app", "branch", "budget", "build", "cache", "caches", "carry", "checkout", "daemons", "deps", "device", "devices",
    "error", "failed", "findings", "fingerprint", "gems", "install", "installs", "ip.txt", "lan", "launch", "lease",
    "lock", "log", "logs", "meaning", "metro", "pods", "port", "prebuild", "project", "readiness", "ready", "remedy",
    "removed", "resolved", "result", "services", "setting", "settings", "setup", "state", "stats", "stop", "storage",
    "swap", "verify", "version", "workspace", "worktrees",
  ]

  /// Parses `lines` in order into step rows. A line whose label repeats the previous row's
  /// label replaces it in place while that row is still running or waiting -- that is how a
  /// build's 30-second heartbeats collapse into one updating row that ends on its final fact.
  /// Once a row is done or failed, a later line with the same label starts a new row, since the
  /// CLI reports distinct facts (e.g. two `stop` lines: the supervisor, then the collector).
  public static func parse(_ lines: [String]) -> [ProgressStep] {
    var accumulator = Accumulator()
    for line in lines { accumulator.append(line) }
    return accumulator.steps
  }

  /// Builds the same rows as `parse` one line at a time, so a running command's rows update
  /// without re-reading the lines already seen.
  public struct Accumulator: Sendable {
    public private(set) var steps: [ProgressStep] = []

    public init() {}

    public mutating func append(_ line: String) {
      guard let step = ActivityProgress.parseLine(line) else { return }
      if let last = steps.last, last.label == step.label, last.state == .running || last.state == .waiting {
        steps[steps.count - 1] = step
      } else {
        steps.append(step)
      }
    }
  }

  /// The first step still waiting on something else, if any -- the CLI's "waiting for ..."
  /// lines the sheet surfaces prominently instead of burying in the step list.
  public static func waitingStep(_ steps: [ProgressStep]) -> ProgressStep? {
    steps.first { $0.state == .waiting }
  }

  private static func parseLine(_ line: String) -> ProgressStep? {
    let range = NSRange(line.startIndex..., in: line)
    guard let match = phaseLine.firstMatch(in: line, range: range),
      let labelRange = Range(match.range(at: 1), in: line),
      let restRange = Range(match.range(at: 2), in: line)
    else { return nil }
    let label = String(line[labelRange])
    guard labels.contains(label) else { return nil }
    let rest = String(line[restRange])
    let (fact, duration) = splitTrailingParenthetical(rest)
    let state: ProgressStep.State
    if label == "error" || label == "failed" || fact.hasPrefix("failed") {
      state = .failed
    } else if fact.hasPrefix("waiting ") {
      state = .waiting
    } else if fact.hasPrefix("still ") {
      state = .running
    } else {
      state = .done
    }
    return ProgressStep(label: label, fact: fact, duration: duration, state: state)
  }

  /// Splits a trailing, balanced `(...)` off the end of `text`, honoring parens nested inside it
  /// (a device fact can itself read `stim-app-412 (iPhone 17 26.5) (BF2A..) booted (9s)`).
  private static func splitTrailingParenthetical(_ text: String) -> (fact: String, duration: String?) {
    guard text.hasSuffix(")") else { return (text, nil) }
    var depth = 0
    var openIndex: String.Index?
    var index = text.index(before: text.endIndex)
    while true {
      let char = text[index]
      if char == ")" { depth += 1 }
      if char == "(" {
        depth -= 1
        if depth == 0 {
          openIndex = index
          break
        }
      }
      if index == text.startIndex { break }
      index = text.index(before: index)
    }
    guard let openIndex, openIndex > text.startIndex else { return (text, nil) }
    let beforeOpen = text.index(before: openIndex)
    guard text[beforeOpen] == " " else { return (text, nil) }
    let duration = String(text[text.index(after: openIndex)..<text.index(before: text.endIndex)])
    let fact = String(text[text.startIndex..<beforeOpen])
    return (fact, duration)
  }
}
