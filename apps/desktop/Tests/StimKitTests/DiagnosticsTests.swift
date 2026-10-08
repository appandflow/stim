import Foundation
import StimKit
import Testing

private final class Recorder: @unchecked Sendable {
  private let lock = NSLock()
  private var crumbs: [DiagnosticBreadcrumb] = []
  private var tagValues: [String: String] = [:]
  private var reportList: [DiagnosticReport] = []

  var breadcrumbs: [DiagnosticBreadcrumb] { lock.withLock { crumbs } }
  var tags: [String: String] { lock.withLock { tagValues } }
  var reports: [DiagnosticReport] { lock.withLock { reportList } }

  var sink: Diagnostics.Sink {
    Diagnostics.Sink(
      breadcrumb: { crumb in self.lock.withLock { self.crumbs.append(crumb) } },
      tag: { key, value in self.lock.withLock { self.tagValues[key] = value } },
      report: { report in self.lock.withLock { self.reportList.append(report) } })
  }

  /// Every string an event or breadcrumb would carry.
  var everything: String {
    lock.withLock {
      var strings: [String] = []
      for crumb in crumbs {
        strings += [crumb.category, crumb.message]
        for (key, value) in crumb.data { strings += [key, value] }
      }
      for (key, value) in tagValues { strings += [key, value] }
      for report in reportList {
        strings.append(report.message)
        for (key, value) in report.tags { strings += [key, value] }
        strings += report.fingerprint
      }
      return strings.joined(separator: "\n")
    }
  }
}

private struct Machine: Decodable {
  var name: String
  enum CodingKeys: String, CodingKey { case name }
}

private struct Payload: Decodable {
  var machines: [String: Machine]
  var list: [Machine]
  enum CodingKeys: String, CodingKey { case machines, list }
}

struct DiagnosticsTests {
  private func scratchDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("acme-secret-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private func fake(in dir: URL, _ script: String) -> String {
    let path = dir.appendingPathComponent("stim").path
    FileManager.default.createFile(atPath: path, contents: Data(script.utf8), attributes: [.posixPermissions: 0o755])
    return path
  }

  @Test func reportsAFailedCommandWithItsNameExitCodeAndStimCodeOnly() async throws {
    let dir = try scratchDirectory()
    defer { try? FileManager.default.removeItem(at: dir) }
    let stim = fake(
      in: dir,
      """
      #!/bin/sh
      echo "STIM_NOT_READY: $PWD feat/acme-launch mini.tail1234.ts.net 100.101.102.103 token=s3cr3tvalue" >&2
      exit 4
      """)
    let recorder = Recorder()
    let diagnostics = Diagnostics()
    diagnostics.install(recorder.sink)
    let cli = StimCLI(environment: ["PATH": "/usr/bin:/bin"], override: stim, diagnostics: diagnostics)

    await #expect(throws: StimCLI.Failure.self) { try await cli.stats(workspace: dir.path) }

    #expect(
      recorder.reports == [
        DiagnosticReport(
          message: "stim command failed",
          tags: ["command": "stats", "outcome": "exited", "exit_code": "4", "stim_code": "STIM_NOT_READY"],
          fingerprint: ["stim-cli", "stats", "exited", "4", "STIM_NOT_READY"])
      ])
    #expect(recorder.tags["last_cli_command"] == "stats")
    #expect(recorder.breadcrumbs.map(\.message) == ["start stats", "finish stats"])
    #expect(recorder.breadcrumbs.last?.data["exit_code"] == "4")
    #expect(Int(recorder.breadcrumbs.last?.data["duration_ms"] ?? "") != nil)
    for secret in [dir.lastPathComponent, "acme", "tail1234", "100.101", "s3cr3t", "feat/"] {
      #expect(!recorder.everything.contains(secret), "leaked \(secret)")
    }
  }

  @Test func reportsATimedOutAndAMissingCommand() async throws {
    let dir = try scratchDirectory()
    defer { try? FileManager.default.removeItem(at: dir) }
    let recorder = Recorder()
    let diagnostics = Diagnostics()
    diagnostics.install(recorder.sink)
    let slow = StimCLI(
      environment: ["PATH": "/usr/bin:/bin"], override: fake(in: dir, "#!/bin/sh\nexec sleep 30\n"),
      diagnostics: diagnostics)
    _ = try? await slow.machineAccess(cwd: dir.path, ask: false, timeout: 1)
    let missing = StimCLI(environment: ["PATH": "/nonexistent"], diagnostics: diagnostics)
    _ = try? await missing.gcReport()

    #expect(
      recorder.reports.map(\.tags) == [
        ["command": "doctor", "outcome": "timed-out"], ["command": "gc", "outcome": "not-found"],
      ])
  }

  @Test func reportsADecodeFailureWithTheTypeAndCodingPathButNoValues() async throws {
    let dir = try scratchDirectory()
    defer { try? FileManager.default.removeItem(at: dir) }
    let recorder = Recorder()
    let diagnostics = Diagnostics()
    diagnostics.install(recorder.sink)
    let json = #"{"machines":{"janics-mac-mini.tail1234.ts.net":{"name":7}},"list":[]}"#

    #expect(throws: DecodingError.self) {
      try decodeReporting(Payload.self, from: Data(json.utf8), source: .server, diagnostics: diagnostics)
    }
    let missing = #"{"machines":{},"list":[{"name":"a"},{}]}"#
    #expect(throws: DecodingError.self) {
      try decodeReporting(Payload.self, from: Data(missing.utf8), source: .cli, diagnostics: diagnostics)
    }

    #expect(
      recorder.reports.map(\.tags) == [
        ["source": "server", "type": "Payload", "coding_path": "machines.<key>.name", "reason": "type-mismatch"],
        ["source": "cli", "type": "Payload", "coding_path": "list.[].name", "reason": "key-not-found"],
      ])
    #expect(!recorder.everything.contains("janics"))
    #expect(!recorder.everything.contains("tail1234"))
  }

  @Test func reportsNoDecodeFailureForAValidPayload() throws {
    let recorder = Recorder()
    let diagnostics = Diagnostics()
    diagnostics.install(recorder.sink)
    let payload = try decodeReporting(
      Payload.self, from: Data(#"{"machines":{},"list":[{"name":"a"}]}"#.utf8), source: .cli, diagnostics: diagnostics)
    #expect(payload.list.count == 1)
    #expect(recorder.reports.isEmpty)
  }

  @Test func sendsEachDistinctFailureOnceAndCapsTheSession() {
    let recorder = Recorder()
    let diagnostics = Diagnostics(maxReports: 3)
    diagnostics.install(recorder.sink)
    diagnostics.report(.server(.noAnswer))
    diagnostics.report(.server(.noAnswer))
    diagnostics.report(.server(.exited))
    diagnostics.report(.cli(command: "status", outcome: .exited(1), stimCode: nil))
    diagnostics.report(.cli(command: "status", outcome: .exited(2), stimCode: nil))
    #expect(
      recorder.reports.map(\.tags) == [
        ["kind": "no-answer"], ["kind": "exited"], ["command": "status", "outcome": "exited", "exit_code": "1"],
      ])
  }

  @Test func recordsNothingAndSpendsNoBudgetWithoutASink() {
    let diagnostics = Diagnostics(maxReports: 1)
    diagnostics.report(.server(.noAnswer))
    diagnostics.breadcrumb("navigation", "overview")
    let recorder = Recorder()
    diagnostics.install(recorder.sink)
    diagnostics.report(.server(.noAnswer))
    #expect(recorder.reports.count == 1)
    #expect(recorder.breadcrumbs.isEmpty)
  }

  @Test func namesOnlyCommandsOfTheCommandSurface() {
    #expect(Diagnostics.commandName(["status", "--json"]) == "status")
    #expect(Diagnostics.commandName(["--version"]) == "version")
    #expect(Diagnostics.commandName(["/Users/janic/acme-secret", "--json"]) == "other")
    #expect(Diagnostics.commandName(["acme-secret-project"]) == "other")
    #expect(Diagnostics.commandName([]) == "other")
  }

  @Test func readsOnlyABareStimCode() {
    #expect(Diagnostics.stimCode(in: ["error STIM_BAD_ARG: nope"]) == "STIM_BAD_ARG")
    #expect(Diagnostics.stimCode(in: ["", #"{"code":"STIM_NO_DEVICE"}"#]) == "STIM_NO_DEVICE")
    #expect(Diagnostics.stimCode(in: ["/Users/janic/STIM_ACME/app", "~/STIM_ACME", "ASTIM_ACME", "STIM_ACME-1"]) == nil)
  }

  @Test func startsTheCrashReporterOnlyForABundleThatCarriesADSN() {
    #expect(Diagnostics.sentryDSN(nil) == nil)
    #expect(Diagnostics.sentryDSN("") == nil)
    #expect(Diagnostics.sentryDSN("  \n") == nil)
    #expect(Diagnostics.sentryDSN(3) == nil)
    #expect(Diagnostics.sentryDSN(" https://key@o1.ingest.sentry.io/2\n") == "https://key@o1.ingest.sentry.io/2")
  }

  @Test func reportsEveryServerFailureKindAsAFixedMessage() {
    for kind in [ServerFailureKind.adoptionHomeMismatch, .launchFailed, .noAnswer, .exited, .tooOld] {
      let report = DiagnosticFailure.server(kind).report
      #expect(report.message == "stim-server start failed")
      #expect(report.tags == ["kind": kind.rawValue])
    }
  }
}
