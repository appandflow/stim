import Foundation
import StimKit
import Testing

@testable import StimStores

private final class Commands: @unchecked Sendable {
  private let lock = NSLock()
  private var launched: [String] = []
  private var outcomes: [Int32?]

  init(_ outcomes: [Int32?]) { self.outcomes = outcomes }

  var names: [String] { lock.withLock { launched } }

  var launch: ActionRun.Launch {
    { command, onLine, onExit in
      let outcome = self.lock.withLock { () -> Int32?? in
        self.launched.append(command.arguments.joined(separator: " "))
        return self.outcomes.isEmpty ? Int32?.none : self.outcomes.removeFirst()
      }
      guard case .some(.some(let status)) = outcome else { throw Failed() }
      DispatchQueue.global().async {
        onLine(OutputLine(.stdout, "out of \(command.arguments.joined(separator: " "))"))
        onExit(status)
      }
    }
  }
}

@MainActor
private func run(_ steps: [String], _ outcomes: [Int32?]) async -> (ActionRun, Commands, finishes: Int) {
  let commands = Commands(outcomes)
  let action = ActionRun(title: "t", steps: steps.map { StimCommand([$0], cwd: "/w") }, key: "/w")
  var finishes = 0
  await withCheckedContinuation { continuation in
    action.start(launch: commands.launch) {
      finishes += 1
      continuation.resume()
    }
  }
  return (action, commands, finishes)
}

@MainActor
struct ActionRunTests {
  @Test func aFailedStepDoesNotStopTheNextOnesAndTheFirstNonZeroStatusWins() async {
    let (action, commands, finishes) = await run(["a", "b", "c"], [3, 0, 7])
    #expect(commands.names == ["a", "b", "c"])
    #expect(action.exitStatus == 3)
    #expect(finishes == 1 && !action.isRunning && action.launchError == nil)
  }

  @Test func theStatusIsTheFirstNonZeroOneAndZeroWhenEveryStepSucceeds() async {
    #expect(await run(["a", "b"], [0, 0]).0.exitStatus == 0)
    #expect(await run(["a", "b", "c"], [0, 5, 9]).0.exitStatus == 5)
    #expect(await run(["a", "b"], [4, 0]).0.exitStatus == 4)
  }

  @Test func aStepThatCannotStartEndsTheRunWithAnErrorAndSkipsTheRest() async {
    let (action, commands, finishes) = await run(["a", "b", "c"], [0, nil, 0])
    #expect(commands.names == ["a", "b"])
    #expect(action.launchError == "scripted failure")
    #expect(action.exitStatus == nil)
    #expect(finishes == 1 && !action.isRunning)
  }

  @Test func stepsPrintTheirCommandAndKeepTheirOutputInOrder() async {
    let (several, _, _) = await run(["a", "b"], [0, 0])
    #expect(several.lines.map(\.text) == ["$ stim a", "out of a", "$ stim b", "out of b"])
    #expect(several.lines.map(\.channel) == [.stderr, .stdout, .stderr, .stdout])

    let (single, _, _) = await run(["a"], [0])
    #expect(single.lines.map(\.text) == ["out of a"])
  }
}
