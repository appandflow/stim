import Foundation
import StimKit

/// One or more Stim commands run one after another. The exit status is the first non-zero status, and a
/// failed step does not stop the ones after it.
@MainActor
final class ActionRun: ObservableObject, Identifiable {
  let id = UUID()
  let title: String
  let steps: [StimCommand]
  let key: String
  let startedAt = Date()
  @Published private(set) var lines: [OutputLine] = []
  @Published private(set) var exitStatus: Int32?
  @Published private(set) var launchError: String?

  init(title: String, steps: [StimCommand], key: String) {
    self.title = title
    self.steps = steps
    self.key = key
  }

  var command: StimCommand { steps[0] }

  var isRunning: Bool { exitStatus == nil && launchError == nil }

  var stdout: Data {
    Data(lines.filter { $0.channel == .stdout }.map(\.text).joined(separator: "\n").utf8)
  }

  /// The last line the command printed, for the autopilot log.
  var summary: String? {
    launchError ?? lines.last { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty && !$0.text.hasPrefix("$ ") }?.text
  }

  fileprivate func start(cli: StimCLI, onFinish: @escaping @MainActor () -> Void) {
    start(step: 0, cli: cli, worst: 0, onFinish: onFinish)
  }

  private func start(step: Int, cli: StimCLI, worst: Int32, onFinish: @escaping @MainActor () -> Void) {
    let command = steps[step]
    if steps.count > 1 {
      lines.append(OutputLine(.stderr, "$ \(([command.program] + command.arguments).joined(separator: " "))"))
    }
    // ProcessStream calls back on background queues in order; the main queue
    // keeps that order, where unstructured Tasks would not.
    do {
      try cli.stream(
        command,
        onLine: { line in
          DispatchQueue.main.async { MainActor.assumeIsolated { self.lines.append(line) } }
        },
        onExit: { status in
          DispatchQueue.main.async {
            MainActor.assumeIsolated {
              let worst = worst != 0 ? worst : status
              if step + 1 < self.steps.count {
                self.start(step: step + 1, cli: cli, worst: worst, onFinish: onFinish)
              } else {
                self.exitStatus = worst
                onFinish()
              }
            }
          }
        })
    } catch {
      launchError = error.localizedDescription
      onFinish()
    }
  }
}

/// Runs Stim commands, at most one at a time per workspace.
@MainActor
final class ActionCenter: ObservableObject {
  static let machineKey = "machine"

  @Published private(set) var runs: [String: ActionRun] = [:]
  @Published var presented: ActionRun?
  var onFinish: (() -> Void)?
  private let cli: Task<StimCLI, Never>

  init(cli: Task<StimCLI, Never>) {
    self.cli = cli
  }

  func active(for key: String) -> ActionRun? {
    runs[key].flatMap { $0.isRunning ? $0 : nil }
  }

  func latest(for key: String) -> ActionRun? { runs[key] }

  /// Runs still in flight, for the toolbar's background-activity indicator.
  var activeRuns: [ActionRun] { runs.values.filter(\.isRunning).sorted { $0.startedAt < $1.startedAt } }

  func run(_ title: String, _ command: StimCommand, key: String? = nil) {
    run(title, steps: [command], key: key)
  }

  /// Starts `steps` unless a run already holds `key`. With `present`, the activity sheet shows the new
  /// run, or the one already running. Returns the new run, or nil when one was already running.
  @discardableResult
  func run(
    _ title: String, steps: [StimCommand], key: String? = nil, present: Bool = true,
    completion: ((ActionRun) -> Void)? = nil
  ) -> ActionRun? {
    let key = key ?? steps[0].cwd
    if let active = active(for: key) {
      if present { presented = active }
      return nil
    }
    let run = ActionRun(title: title, steps: steps, key: key)
    runs[key] = run
    if present { presented = run }
    let cli = cli
    Task { [weak self] in
      run.start(cli: await cli.value) { [weak self] in
        self?.objectWillChange.send()
        self?.onFinish?()
        completion?(run)
      }
    }
    return run
  }
}
