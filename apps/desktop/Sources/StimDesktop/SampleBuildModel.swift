import Foundation
import Observation
import StimKit

struct WizardCommandOutput {
  var exit: Int32
  var stdout: Data
  var stderr: String
}

@MainActor @Observable
final class SampleBuildModel {
  struct Dependencies {
    var sample: WizardSample
    var run: (StimCommand, @escaping @MainActor (OutputLine) -> Void) async throws -> WizardCommandOutput
    var exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }
    var create: (URL) throws -> Void = { try FileManager.default.createDirectory(at: $0, withIntermediateDirectories: true) }
    var move: (URL, URL) throws -> Void = { try FileManager.default.moveItem(at: $0, to: $1) }
    var remove: (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) }
    var mark: (URL) throws -> Void = { try Data().write(to: $0, options: .atomic) }
    var now: () -> Date = Date.init
  }
  private(set) var test = BuildTest()
  private(set) var lines: [TerminalLine] = []
  private(set) var sampleReady = false
  private(set) var preparing = false
  private(set) var running = false
  private(set) var startedAt: Date?
  private(set) var cleanupError: String?
  let dependencies: Dependencies
  @ObservationIgnored private var preparation: Task<Void, Never>?
  @ObservationIgnored private var build: Task<Void, Never>?
  @ObservationIgnored private var cleanup: Task<Void, Never>?

  init(dependencies: Dependencies) { self.dependencies = dependencies }
  convenience init(cli: Task<StimCLI, Never>) {
    self.init(
      dependencies: .init(
        sample: .desktop,
        run: { command, onLine in
          try await WizardStream.run(cli: await cli.value, command: command, onLine: onLine)
        }))
  }
  var folder: String { dependencies.sample.folder.path }

  func prepare() {
    guard preparation == nil, !sampleReady else { return }
    preparing = true
    test.apply(.prepare)
    preparation = Task {
      defer {
        preparing = false
        preparation = nil
      }
      do {
        let sample = dependencies.sample
        guard sample.permitsRemoval(sample.folder) else { throw CocoaError(.fileWriteNoPermission) }
        if dependencies.exists(sample.marker) {
          sampleReady = true
          test.apply(.prepared)
          return
        }
        if dependencies.exists(sample.folder) {
          try await removeSample()
        }
        try dependencies.create(sample.onboarding)
        let generated = sample.onboarding.appendingPathComponent("sample")
        guard !dependencies.exists(generated) else { throw CocoaError(.fileWriteFileExists) }
        do {
          for (index, command) in sample.prepareCommands.enumerated() {
            let output = try await dependencies.run(command, receive)
            try Task.checkCancellation()
            guard output.exit == 0 else { throw StimCLI.Failure.exited(output.exit, stderr: output.stderr) }
            if index == 0 { try dependencies.move(generated, sample.folder) }
          }
        } catch {
          if dependencies.exists(generated) { try? dependencies.remove(generated) }
          throw error
        }
        try Task.checkCancellation()
        try dependencies.mark(sample.marker)
        sampleReady = true
        test.apply(.prepared)
      } catch is CancellationError {
      } catch {
        let detail: String
        if let failure = error as? StimCLI.Failure, case .exited(_, let stderr) = failure, !stderr.isEmpty {
          detail = stderr
        } else {
          detail = error.localizedDescription
        }
        test.apply(.fail(code: "SAMPLE_PREPARE_FAILED", message: "Could not create the sample app: \(detail)", remedy: nil))
      }
    }
  }

  func waitForPreparation() async {
    await preparation?.value
  }

  func run(entry: String) {
    guard sampleReady, !running, cleanup == nil else { return }
    running = true
    cleanupError = nil
    lines = []
    startedAt = dependencies.now()
    test.apply(.start)
    build = Task {
      do {
        try await checked(["start"])
        let output = try await dependencies.run(
          StimCommand(["ios", "--build-machine", entry, "--no-build-cache", "--json"], cwd: folder), receive)
        try Task.checkCancellation()
        let result = try OffloadResult.parse(output.stdout, machine: entry, exit: output.exit, stderr: output.stderr)
        test.apply(.offload(result))
        if result == .success {
          let log = try await checked(["logs", "--json", "--source", "build", "--grep", "^built on ", "--tail", "5"])
          let timings = try BuildTimings.record(log.stdout)
          test.apply(.timings(timings))
          test.apply(.localStart)
          let began = dependencies.now()
          let local = try await dependencies.run(
            StimCommand(["ios", "--build-machine", "local", "--no-build-cache", "--json"], cwd: folder), receive)
          try Task.checkCancellation()
          if let refusal = try? JSONDecoder().decode(CommandRefusal.self, from: local.stdout) {
            test.apply(.fail(code: refusal.code, message: refusal.message, remedy: refusal.remedy))
          } else {
            test.apply(
              .localFinished(
                passed: try OffloadResult.localPassed(local.stdout, exit: local.exit, stderr: local.stderr),
                ms: dependencies.now().timeIntervalSince(began) * 1000))
          }
        }
      } catch is CancellationError {
      } catch {
        test.apply(
          .fail(code: "TEST_BUILD_FAILED", message: error.localizedDescription, remedy: "Check the output and run again."))
      }
      do { try await Task { try await stopSample() }.value } catch { cleanupError = error.localizedDescription }
      running = false
      build = nil
    }
  }

  func skip() async {
    test.apply(.skip)
    await end()
  }

  func end() async {
    if let cleanup {
      await cleanup.value
      return
    }
    let preparation = preparation
    let build = build
    preparation?.cancel()
    build?.cancel()
    let task = Task {
      await preparation?.value
      await build?.value
      if build == nil, sampleReady || dependencies.exists(dependencies.sample.folder) {
        do { try await stopSample() } catch { cleanupError = error.localizedDescription }
      }
    }
    cleanup = task
    await task.value
    cleanup = nil
  }

  func removeSample() async throws {
    let sample = dependencies.sample
    guard sample.permitsRemoval(sample.folder) else { throw CocoaError(.fileWriteNoPermission) }
    var teardown = [StimCommand(["stop"], cwd: folder)]
    if !dependencies.exists(sample.folder.appendingPathComponent(".git")) {
      teardown.append(StimCommand(["init"], cwd: folder, program: "git"))
    }
    teardown.append(StimCommand(["worktree", "remove", folder], cwd: sample.onboarding.path))
    for command in teardown {
      let output = try await dependencies.run(command, { _ in })
      guard output.exit == 0 else {
        let stderr = output.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        throw StimCLI.Failure.exited(
          output.exit, stderr: "\(command.program) \(command.arguments.joined(separator: " ")) failed: \(stderr)")
      }
    }
    guard sample.permitsRemoval(sample.folder) else { throw CocoaError(.fileWriteNoPermission) }
    try dependencies.remove(sample.folder)
  }

  private func stopSample() async throws {
    let output = try await dependencies.run(StimCommand(["stop"], cwd: folder), { _ in })
    guard output.exit == 0 else { throw StimCLI.Failure.exited(output.exit, stderr: output.stderr) }
  }

  @discardableResult private func checked(_ arguments: [String]) async throws -> WizardCommandOutput {
    let output = try await dependencies.run(StimCommand(arguments, cwd: folder), receive)
    try Task.checkCancellation()
    guard output.exit == 0 else { throw StimCLI.Failure.exited(output.exit, stderr: output.stderr) }
    return output
  }
  private func receive(_ line: OutputLine) {
    if line.channel == .stderr {
      lines.append(TerminalLine(text: line.text, kind: .output))
      if lines.count > 120 { lines.removeFirst(lines.count - 120) }
      test.apply(.progress(line.text))
    }
  }

  #if DEBUG
    func fixture(_ events: [BuildTest.Event], lines: [TerminalLine] = []) {
      for event in events { test.apply(event) }
      self.lines = lines
      switch test.state {
      case .offloading, .offloaded, .localBuilding: running = true
      default: running = false
      }
      sampleReady = events.contains {
        if case .prepared = $0 { return true }
        return false
      }
    }
  #endif
}

@MainActor private enum WizardStream {
  private enum Event: Sendable {
    case line(OutputLine)
    case exit(Int32)
  }
  static func run(cli: StimCLI, command: StimCommand, onLine: @escaping @MainActor (OutputLine) -> Void) async throws
    -> WizardCommandOutput
  {
    try Task.checkCancellation()
    let (stream, continuation) = AsyncStream<Event>.makeStream()
    let process = try cli.stream(
      command, onLine: { continuation.yield(.line($0)) },
      onExit: {
        continuation.yield(.exit($0))
        continuation.finish()
      })
    let consumer = Task {
      var stdout = ""
      var stderr: [String] = []
      var exit: Int32 = -1
      for await event in stream {
        switch event {
        case .line(let line):
          onLine(line)
          if line.channel == .stdout {
            stdout += line.text + "\n"
          } else {
            stderr.append(line.text)
            stderr = Array(stderr.suffix(3))
          }
        case .exit(let status): exit = status
        }
      }
      return WizardCommandOutput(exit: exit, stdout: Data(stdout.utf8), stderr: stderr.joined(separator: "\n"))
    }
    let result = await withTaskCancellationHandler {
      await consumer.value
    } onCancel: {
      if process.isRunning { process.terminate() }
      DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      }
    }
    try Task.checkCancellation()
    return result
  }
}

@MainActor enum WizardToolsDoctor {
  static func read(cli: StimCLI, cwd: String, platform: String) async throws -> DoctorReport {
    let output = try await WizardStream.run(
      cli: cli, command: StimCommand(["doctor", "--json", "--platform", platform], cwd: cwd), onLine: { _ in })
    guard output.exit == 0 else { throw StimCLI.Failure.exited(output.exit, stderr: output.stderr) }
    guard let report = DoctorReport.decode(output.stdout) else {
      throw StimCLI.Failure.exited(output.exit, stderr: output.stderr)
    }
    return report
  }
}
