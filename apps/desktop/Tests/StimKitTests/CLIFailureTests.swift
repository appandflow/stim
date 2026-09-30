import Foundation
import StimKit
import Testing

struct CLIFailureTests {
  private struct Boom: LocalizedError {
    var errorDescription: String? { "boom" }
  }

  @Test func keepsTheLastValueWhenARunFailsUntilOneSucceeds() {
    var fetched = Fetched<Int>()
    fetched.record(.failure(Boom()))
    #expect(fetched.value == nil)
    #expect(fetched.error == "boom")
    fetched.record(.success(1))
    fetched.record(.failure(Boom()))
    #expect(fetched.value == 1)
    #expect(fetched.error == "boom")
    fetched.record(.success(2))
    #expect(fetched.value == 2)
    #expect(fetched.error == nil)
  }

  @Test func namesTheLastStderrLinesOfAFailedCommandPastAFullPipeBuffer() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let stim = dir.appendingPathComponent("stim").path
    let script = """
      #!/bin/sh
      head -c 200000 /dev/zero | tr '\\0' 'x' >&2
      printf '\\nfirst\\n\\nsecond\\nerror: disk full\\n' >&2
      exit 2
      """
    FileManager.default.createFile(atPath: stim, contents: Data(script.utf8), attributes: [.posixPermissions: 0o755])

    let cli = StimCLI(environment: ["PATH": "/usr/bin:/bin"], override: stim)

    let error = await #expect(throws: StimCLI.Failure.self) { try await cli.gcReport() }
    #expect(error?.localizedDescription == "stim exited with status 2: first\nsecond\nerror: disk full")
  }

  @Test func throwsNotFoundWithoutRunningAnythingWhenStimIsMissing() async {
    let cli = StimCLI(environment: ["PATH": "/nonexistent"])

    let error = await #expect(throws: StimCLI.Failure.self) { try await cli.status() }
    guard case .notFound = error else {
      Issue.record("expected notFound, got \(String(describing: error))")
      return
    }
  }

  @Test func namesTheStderrOfAFailedStimServerCommand() async throws {
    let dir = try scratchDirectory()
    defer { try? FileManager.default.removeItem(at: dir) }
    let server = try fake(
      in: dir, name: "stim-server",
      """
      #!/bin/sh
      printf '\nNo device named phone-1.\n\n' >&2
      exit 3
      """)

    let cli = StimServerCLI(environment: ["PATH": "/usr/bin:/bin"], override: server)

    let error = await #expect(throws: StimServerCLI.Failure.self) { try await cli.revoke("phone-1") }
    #expect(error?.localizedDescription == "No device named phone-1.")
  }

  @Test func deliversNoResultThatTheProcessPrintsAfterTheTaskIsCancelled() async throws {
    let dir = try scratchDirectory()
    defer { try? FileManager.default.removeItem(at: dir) }
    let pidFile = dir.appendingPathComponent("pid").path
    let stim = try fake(
      in: dir, name: "stim",
      """
      #!/bin/sh
      trap 'echo terminated > "\(dir.path)/terminated"' TERM
      echo $$ > "\(pidFile)"
      sleep 1
      echo '{"environments":[]}'
      """)
    let cli = StimCLI(environment: ["PATH": "/usr/bin:/bin"], override: stim)

    let task = Task { try await cli.status() }
    while !FileManager.default.fileExists(atPath: pidFile) { try await Task.sleep(for: .milliseconds(20)) }
    task.cancel()

    await #expect(throws: CancellationError.self) { try await task.value }
    #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("terminated").path))
  }

  @Test func startsNoProcessForATaskCancelledBeforeItRuns() async throws {
    let dir = try scratchDirectory()
    defer { try? FileManager.default.removeItem(at: dir) }
    let marker = dir.appendingPathComponent("ran").path
    let stim = try fake(
      in: dir, name: "stim",
      """
      #!/bin/sh
      touch "\(marker)"
      echo '{"environments":[]}'
      """)
    let cli = StimCLI(environment: ["PATH": "/usr/bin:/bin"], override: stim)

    let task = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await cli.status()
    }

    await #expect(throws: CancellationError.self) { try await task.value }
    #expect(!FileManager.default.fileExists(atPath: marker))
  }

  @Test func runsMoreCommandsAtOnceThanTheCooperativePoolHasThreads() async throws {
    let dir = try scratchDirectory()
    defer { try? FileManager.default.removeItem(at: dir) }
    let release = dir.appendingPathComponent("release").path
    let stim = try fake(
      in: dir, name: "stim",
      """
      #!/bin/sh
      touch "\(dir.path)/started-$$"
      i=0
      while [ ! -f "\(release)" ]; do
        [ $i -ge 200 ] && touch "\(dir.path)/timed-out-$$" && break
        sleep 0.05
        i=$((i + 1))
      done
      echo 1.11.0
      """)
    let cli = StimCLI(environment: ["PATH": "/usr/bin:/bin"], override: stim)
    let count = ProcessInfo.processInfo.activeProcessorCount + 2

    let runs = (0..<count).map { _ in Task { await cli.versionOutput() } }
    let deadline = Date().addingTimeInterval(5)
    var started = 0
    while started < count, Date() < deadline {
      try await Task.sleep(for: .milliseconds(50))
      started = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix("started-") }.count
    }
    FileManager.default.createFile(atPath: release, contents: nil)

    for run in runs { #expect(await run.value == "1.11.0\n") }
    #expect(started == count)
    #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix("timed-out-") }.isEmpty)
  }

  private func scratchDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private func fake(in dir: URL, name: String, _ script: String) throws -> String {
    let path = dir.appendingPathComponent(name).path
    FileManager.default.createFile(atPath: path, contents: Data(script.utf8), attributes: [.posixPermissions: 0o755])
    return path
  }
}
