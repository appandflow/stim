import Foundation
import StimKit

@MainActor
final class ActionRun: ObservableObject, Identifiable {
  let id = UUID()
  let title: String
  let command: StimCommand
  @Published private(set) var lines: [OutputLine] = []
  @Published private(set) var exitStatus: Int32?
  @Published private(set) var launchError: String?

  init(title: String, command: StimCommand) {
    self.title = title
    self.command = command
  }

  var isRunning: Bool { exitStatus == nil && launchError == nil }

  var stdout: Data {
    Data(lines.filter { $0.channel == .stdout }.map(\.text).joined(separator: "\n").utf8)
  }

  fileprivate func start(onFinish: @escaping @MainActor () -> Void) {
    // ProcessStream calls back on background queues in order; the main queue
    // keeps that order, where unstructured Tasks would not.
    do {
      try StimCLI.stream(
        command.arguments, cwd: command.cwd,
        onLine: { line in
          DispatchQueue.main.async { MainActor.assumeIsolated { self.lines.append(line) } }
        },
        onExit: { status in
          DispatchQueue.main.async {
            MainActor.assumeIsolated {
              self.exitStatus = status
              onFinish()
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

  func active(for key: String) -> ActionRun? {
    runs[key].flatMap { $0.isRunning ? $0 : nil }
  }

  func latest(for key: String) -> ActionRun? { runs[key] }

  func run(_ title: String, _ command: StimCommand, key: String? = nil) {
    let key = key ?? command.cwd
    if let active = active(for: key) {
      presented = active
      return
    }
    let run = ActionRun(title: title, command: command)
    runs[key] = run
    presented = run
    run.start { [weak self] in
      self?.objectWillChange.send()
      self?.onFinish?()
    }
  }
}
