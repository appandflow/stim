import Foundation
import Testing

@testable import StimKit

@Suite struct LogRecordTests {
  let records: [LogRecord] = {
    let url = Bundle.module.url(forResource: "logs", withExtension: "ndjson", subdirectory: "Fixtures")!
    let text = try! String(contentsOf: url, encoding: .utf8)
    return text.split(separator: "\n").compactMap(LogRecord.parse)
  }()

  @Test func decodesEveryCapturedRecordAndIgnoresFieldsItDoesNotModel() {
    #expect(records.count == 10)
    #expect(records.map(\.src) == [
      "metro", "metro", "metro", "build", "build", "device", "device", "device", "device", "build",
    ])
    #expect(records[1].marker == true)
    #expect(records[3].platform == "ios")
  }

  @Test func leavesTheSlotEmptyOnUntaggedRecords() {
    #expect(records[0].slot == nil)
    #expect(records[4].slot == "ipad")
  }

  @Test func keepsMultiLineMessagesWhole() {
    #expect(records[6].msg.split(separator: "\n", omittingEmptySubsequences: false).count == 5)
    #expect(records[5].msg.contains("\n\tpath: satisfied"))
  }

  @Test func decodesStackFramesWithoutLineNumbers() throws {
    let crash = records[7]
    #expect(crash.level == .fatal)
    #expect(crash.event == "native_crash")
    let stack = try #require(crash.stack)
    #expect(stack.count == 3)
    #expect(stack[0].description == "+0x6575712d7400 [unsymbolicated] (<unknown image>)")
    #expect(stack[0].line == nil)
  }

  @Test func decodesAFrameWithUnexpectedTypesAsFarAsItCan() throws {
    let record = try #require(
      LogRecord.parse(
        #"{"ts":1,"src":"client","level":"error","msg":"boom","stack":[{"file":"a.js","line":"12","column":3,"fn":"f"}]}"#
      ))
    #expect(record.stack?.first?.description == "f (a.js)")
  }

  @Test func keepsANewerSourceAndLevel() throws {
    let record = try #require(LogRecord.parse(#"{"ts":1,"src":"network","level":"trace","msg":"x"}"#))
    #expect(record.src == "network")
    #expect(record.source == nil)
    #expect(record.level == .info)
  }

  @Test func decodesTheDeviceOfAnAgentAction() throws {
    let record = try #require(
      LogRecord.parse(
        #"{"ts":1790340231708,"src":"agent","level":"info","msg":"Tapped @e7","event":"agent_action","command":"press","session":"e2e1175","platform":"ios","deviceId":"2FA9C340-A259-4420-A617-316DC159FF84","details":{"command":"press","ref":"e7","x":193,"y":393}}"#
      ))
    #expect(record.source == .agent)
    #expect(record.deviceId == "2FA9C340-A259-4420-A617-316DC159FF84")
  }

  @Test func skipsLinesThatAreNotRecords() {
    #expect(LogRecord.parse("") == nil)
    #expect(LogRecord.parse("Debugger listening on ws://127.0.0.1") == nil)
    #expect(LogRecord.parse(#"{"ts":1,"src":"metro","level":"info"}"#) == nil)
  }
}

@Suite struct LogQueryTests {
  @Test func passesNoSourceWhenEverySourceIsSelectedSoErrorsKeepsTheDefaultScope() {
    var query = LogQuery()
    query.errorsOnly = true
    #expect(query.arguments == ["logs", "--json", "--follow", "--tail", "5000", "--errors"])
  }

  @Test func namesTheAgentSourceWhenItIsTheOnlyOne() {
    var query = LogQuery()
    query.sources = [.agent]
    #expect(query.arguments == ["logs", "--json", "--follow", "--tail", "5000", "--source", "agent"])
  }

  @Test func passesEveryFilter() {
    var query = LogQuery()
    query.sources = [.build, .metro]
    query.slot = "ipad"
    query.minimumLevel = .warn
    query.search = "Bundl(ed|ing)"
    query.tail = 10
    #expect(
      query.arguments == [
        "logs", "--json", "--follow", "--tail", "10", "--source", "metro", "build", "--slot", "ipad", "--level",
        "warn", "--grep", "Bundl(ed|ing)",
      ])
  }
}

@MainActor
@Suite struct LogFollowerTests {
  private final class Events {
    var records: [LogRecord] = []
    var exits: [(Int32, [String])] = []
  }

  private let dir: URL
  private let cli: StimCLI

  init() throws {
    dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("stim-logs-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let script = dir.appendingPathComponent("stim")
    try """
      #!/bin/sh
      case "$*" in *--errors*) echo "STIM_NO_PROJECT: no timeline" >&2; exit 1;; esac
      printf '{"ts":1,"src":"metro","level":"info","msg":"%s"}\\n' "$*"
      exec sleep 30
      """.write(to: script, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    cli = StimCLI(environment: ["STIM_BIN": script.path, "PATH": "/usr/bin:/bin"])
  }

  private func waitUntil(_ condition: () -> Bool) async {
    for _ in 0..<100 where !condition() { try? await Task.sleep(for: .milliseconds(50)) }
  }

  @Test func restartingTerminatesThePreviousProcessAndStopLeavesNoneRunning() async throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    let events = Events()
    let follower = LogFollower { event in
      if case .records(let batch) = event { events.records += batch }
      if case .exited(let status, let stderr) = event { events.exits.append((status, stderr)) }
    }
    var query = LogQuery()
    query.tail = 1
    follower.start(query, cli: cli, cwd: dir.path)
    let first = try #require(follower.runningProcess)
    await waitUntil { !events.records.isEmpty }

    query.tail = 2
    follower.start(query, cli: cli, cwd: dir.path)
    let second = try #require(follower.runningProcess)
    await waitUntil { !first.isRunning && events.records.count == 2 }
    #expect(!first.isRunning)
    #expect(second.isRunning)
    #expect(events.records.map(\.msg) == ["logs --json --follow --tail 1", "logs --json --follow --tail 2"])

    follower.stop()
    await waitUntil { !second.isRunning }
    try await Task.sleep(for: .milliseconds(300))
    #expect(!second.isRunning)
    #expect(events.exits.isEmpty)
  }

  @Test func reportsTheRefusalOnStderr() async throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    let events = Events()
    let follower = LogFollower { event in
      if case .exited(let status, let stderr) = event { events.exits.append((status, stderr)) }
    }
    var query = LogQuery()
    query.errorsOnly = true
    follower.start(query, cli: cli, cwd: dir.path)
    await waitUntil { !events.exits.isEmpty }
    #expect(events.exits.first?.0 == 1)
    #expect(events.exits.first?.1 == ["STIM_NO_PROJECT: no timeline"])
    #expect(follower.runningProcess == nil)
  }
}
