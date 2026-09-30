import Foundation
import StimKit

/// One or more Stim commands run one after another. The exit status is the first non-zero status, and a
/// failed step does not stop the ones after it.
@MainActor
public final class ActionRun: ObservableObject, Identifiable {
  /// Starts `command` and reports its lines and then its exit status from background queues, as `StimCLI.stream`
  /// does; throws when it cannot start.
  public typealias Launch =
    @Sendable (
      StimCommand, @escaping @Sendable (OutputLine) -> Void, @escaping @Sendable (Int32) -> Void
    ) throws -> Void

  public let id = UUID()
  public let title: String
  public let steps: [StimCommand]
  public let key: String
  public let startedAt = Date()
  @Published public private(set) var output: ActionOutput
  @Published public private(set) var exitStatus: Int32?
  @Published public private(set) var launchError: String?

  public init(title: String, steps: [StimCommand], key: String) {
    self.title = title
    self.steps = steps
    self.key = key
    output = ActionOutput(keepsStdout: steps.count == 1 && steps[0].arguments.contains("--json"))
  }

  public var lines: [OutputLine] { output.lines }

  public var progress: [ProgressStep] { output.steps }

  public var command: StimCommand { steps[0] }

  public var isRunning: Bool { exitStatus == nil && launchError == nil }

  /// The whole stdout of a single `--json` command; empty for any other run.
  public var stdout: Data { output.stdout }

  /// What a finished `gc --delete --json` or `gc --idle --json` run did, or nil for any other command.
  public var gcOutcome: Result<GcOutcome, Error>? {
    guard steps.count == 1, exitStatus != nil, GcOutcome.describes(command.arguments) else { return nil }
    return Result { try GcOutcome(json: stdout) }
  }

  /// The output to show as text: everything but the JSON payload of a `--json` command.
  public var logLines: [OutputLine] {
    command.arguments.contains("--json") ? lines.filter { $0.channel != .stdout } : lines
  }

  /// One line for the autopilot log: the cleanup summary, or the last line the command printed.
  public var summary: String? {
    if let launchError { return launchError }
    if case .success(let outcome) = gcOutcome { return outcome.headline }
    return logLines.last { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty && !$0.text.hasPrefix("$ ") }?.text
  }

  func start(launch: @escaping Launch, onFinish: @escaping @MainActor () -> Void) {
    start(step: 0, launch: launch, worst: 0, onFinish: onFinish)
  }

  private func start(step: Int, launch: @escaping Launch, worst: Int32, onFinish: @escaping @MainActor () -> Void) {
    let command = steps[step]
    if steps.count > 1 {
      output.append([OutputLine(.stderr, "$ \(([command.program] + command.arguments).joined(separator: " "))")])
    }
    // ProcessStream calls back on background queues in order; the batcher hands
    // the lines to the main queue in that order, one batch per 100 ms.
    let batcher = OutputBatcher { [weak self] batch in self?.output.append(batch) }
    do {
      try launch(
        command,
        { line in batcher.receive(line) },
        { status in
          DispatchQueue.main.async {
            MainActor.assumeIsolated {
              batcher.flush()
              let worst = worst != 0 ? worst : status
              if step + 1 < self.steps.count {
                self.start(step: step + 1, launch: launch, worst: worst, onFinish: onFinish)
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
public final class ActionCenter: ObservableObject {
  public static let machineKey = "machine"

  @Published public private(set) var runs: [String: ActionRun] = [:]
  @Published public var presented: ActionRun?
  public var onFinish: ((ActionRun) -> Void)?
  private let cli: Task<StimCLI, Never>

  public init(cli: Task<StimCLI, Never>) {
    self.cli = cli
  }

  public func active(for key: String) -> ActionRun? {
    runs[key].flatMap { $0.isRunning ? $0 : nil }
  }

  public func latest(for key: String) -> ActionRun? { runs[key] }

  /// Runs still in flight, for the toolbar's background-activity indicator.
  public var activeRuns: [ActionRun] { runs.values.filter(\.isRunning).sorted { $0.startedAt < $1.startedAt } }

  public func run(_ title: String, _ command: StimCommand, key: String? = nil) {
    run(title, steps: [command], key: key)
  }

  /// Starts `steps` unless a run already holds `key`. With `present`, the activity sheet shows the new
  /// run, or the one already running. Returns the new run, or nil when one was already running.
  @discardableResult
  public func run(
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
      let stim = await cli.value
      run.start(launch: { command, onLine, onExit in
        try stim.stream(command, onLine: onLine, onExit: onExit)
      }) { [weak self] in
        self?.objectWillChange.send()
        self?.onFinish?(run)
        completion?(run)
      }
    }
    return run
  }

  public func runApp(_ env: Workspace, platform: String) {
    run("Run \(env.names.title) on \(platformName(platform))", StimCommand([platform], cwd: env.path))
  }
}
