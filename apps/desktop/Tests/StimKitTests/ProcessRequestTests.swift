import Foundation
import StimKit
import Testing

struct ProcessRequestTests {
  private func sh(_ script: String, timeout: TimeInterval? = nil) -> ProcessRequest {
    ProcessRequest("/bin/sh", ["-c", script], timeout: timeout)
  }

  @Test func returnsStatusAndStdout() async throws {
    let result = try await sh("printf out; exit 3").run()
    #expect(result.status == 3)
    #expect(result.stdoutText == "out")
    #expect(result.exited && !result.timedOut && !result.succeeded)
  }

  @Test func passesTheWorkingDirectoryAndOnlyTheGivenEnvironment() throws {
    var request = ProcessRequest(
      "/bin/sh", ["-c", "pwd -P; printf '%s|%s' \"$STIM_TEST_VALUE\" \"$HOME\""], cwd: "/private/tmp",
      environment: ["STIM_TEST_VALUE": "yes"])
    request.captureStderr = true
    let result = try request.runBlocking()
    #expect(result.stdoutText == "/private/tmp\nyes|")
    #expect(result.succeeded)
  }

  @Test func readsAllStdoutWhileStderrFillsPastAPipeBuffer() async throws {
    var request = sh("head -c 300000 /dev/zero >&2; head -c 300000 /dev/zero | tr '\\0' x; echo done >&2")
    request.captureStderr = true
    let result = try await request.run()
    #expect(result.stdout.count == 300_000)
    #expect(result.stderr.count == 4096)
    #expect(result.stderrText.hasSuffix("done\n"))
  }

  @Test func leavesStderrEmptyUnlessAskedFor() throws {
    #expect(try sh("echo oops >&2").runBlocking().stderr.isEmpty)
  }

  @Test func stopsAProcessAtItsTimeoutAndKeepsItsOutput() async throws {
    let started = Date()
    let result = try await sh("echo partial; sleep 30", timeout: 0.5).run()
    #expect(result.timedOut && !result.succeeded)
    #expect(result.stdoutText == "partial\n")
    #expect(Date().timeIntervalSince(started) < 10)
  }

  @Test func killsAProcessThatIgnoresTheTimeoutSignal() throws {
    var request = ProcessRequest("/usr/bin/perl", ["-e", "$SIG{TERM} = 'IGNORE'; sleep 30"], timeout: 0.3)
    request.killGrace = 0.3
    let started = Date()
    let result = try request.runBlocking()
    #expect(result.timedOut)
    #expect(Date().timeIntervalSince(started) < 10)
  }

  @Test func sendsTheChosenTimeoutSignal() throws {
    var request = ProcessRequest("/usr/bin/perl", ["-e", "$SIG{TERM} = 'IGNORE'; sleep 30"], timeout: 0.3)
    request.timeoutSignal = SIGKILL
    request.killGrace = 30
    let started = Date()
    let result = try request.runBlocking()
    #expect(result.timedOut && !result.exited)
    #expect(Date().timeIntervalSince(started) < 10)
  }

  @Test func endsWhenABackgroundChildKeepsTheOutputOpen() throws {
    let started = Date()
    let result = try sh("echo hi; sleep 30 &").runBlocking()
    #expect(result.stdoutText == "hi\n")
    #expect(Date().timeIntervalSince(started) < 10)
  }

  @Test func cancellingTheTaskTerminatesTheProcess() async throws {
    let started = Date()
    let task = Task { try await sh("sleep 30").run() }
    try await Task.sleep(for: .milliseconds(300))
    task.cancel()
    await #expect(throws: CancellationError.self) { try await task.value }
    #expect(Date().timeIntervalSince(started) < 10)
  }

  @Test func doesNotStartAProcessForACancelledTask() async throws {
    let marker = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: marker) }
    let task = Task {
      while !Task.isCancelled { await Task.yield() }
      return try await sh("touch \(marker.path)").run()
    }
    task.cancel()
    await #expect(throws: CancellationError.self) { try await task.value }
    #expect(!FileManager.default.fileExists(atPath: marker.path))
  }

  @Test func throwsWhenTheExecutableIsMissing() async {
    let request = ProcessRequest("/nonexistent/stim-tool")
    await #expect(throws: (any Error).self) { try await request.run() }
    #expect(throws: (any Error).self) { try request.runBlocking() }
  }

  @Test func terminatesRegisteredProcesses() async throws {
    let registry = ProcessRegistry()
    var request = sh("sleep 30")
    request.registry = registry
    let task = Task { try await request.run() }
    try await Task.sleep(for: .milliseconds(300))
    registry.terminateAll()
    let result = try await task.value
    #expect(!result.exited && !result.succeeded)
  }
}
