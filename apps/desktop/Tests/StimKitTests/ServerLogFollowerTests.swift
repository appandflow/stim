import Foundation
import Testing

@testable import StimKit

@MainActor @Suite(.serialized) struct LogFollowerTests {
  private let environment = ["STIM_HOME": "/tmp/stim"]

  private func connection(scheduler: @escaping ServerScheduler = ServerClient.dispatchAfter) async throws -> (
    ServerClient, FakeTransport
  ) {
    var transport: FakeTransport?
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim/server/local.sock"), clientName: "Logs", clientVersion: "1",
      transport: { _, onEvent in
        let next = FakeTransport(onEvent: onEvent)
        transport = next
        return next
      }, scheduler: scheduler)
    client.start()
    await settle()
    let socket = try #require(transport)
    socket.answer(
      "hello",
      .object([
        "protocol": .number(2), "server": .object(["name": .string("Mac"), "version": .string("1"), "stim": .string("1")]),
        "capabilities": .array([.string("read")]), "features": .array([.string("desktop-full-logs")]),
      ]))
    await settle()
    return (client, socket)
  }

  private func logs(_ socket: FakeTransport, _ subscription: String, _ message: String) {
    socket.reply([
      "event": .string("logs"), "subscription": .string(subscription),
      "records": .array([
        .object(["ts": .number(1), "src": .string("build"), "level": .string("info"), "msg": .string(message)]),
        .object(["ts": .number(1), "src": .string("build"), "marker": .bool(true)]),
      ]),
    ])
  }

  private func waitUntil(_ condition: () -> Bool) async {
    for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(25)) }
  }

  @Test func replacingAndStoppingQueriesDiscardOldBatchesWithoutDisconnecting() async throws {
    let (client, socket) = try await connection()
    defer { client.stop() }
    var messages: [String] = []
    let follower = LogFollower { if case .records(let records) = $0 { messages += records.map(\.msg) } }
    follower.start(LogQuery(), stimHome: StimHome.path(environment: environment), connection: (client, "/tmp/stim"), cwd: "/app")
    await settle()
    socket.answer("logs.subscribe", .object(["subscription": .string("s1")]))
    await settle()
    logs(socket, "s1", "old")
    follower.start(
      LogQuery(), stimHome: StimHome.path(environment: environment), connection: (client, "/tmp/stim"), cwd: "/other")
    await settle()
    socket.answer("unsubscribe", .object([:]))
    socket.answer("logs.subscribe", .object(["subscription": .string("s2")]))
    await settle()
    logs(socket, "s1", "late")
    logs(socket, "s2", "new")
    await waitUntil { messages.contains("new") }
    #expect(messages == ["new"])
    follower.stop()
    await settle()
    socket.answer("unsubscribe", .object([:]))
    logs(socket, "s2", "after stop")
    try await Task.sleep(for: .milliseconds(150))
    #expect(messages == ["new"])
    #expect(client.isOpen)
  }

  @Test func aRetriedSubscriptionReplacesItsBackfillInsteadOfDuplicatingRows() async throws {
    var retry: (@MainActor () -> Void)?
    let (client, socket) = try await connection(scheduler: { _, work in
      retry = work
      return {}
    })
    defer { client.stop() }
    var shown: [String] = []
    var resets = 0
    let follower = LogFollower {
      if case .reset = $0 {
        shown = []
        resets += 1
      }
      if case .records(let records) = $0 { shown += records.map(\.msg) }
    }
    follower.start(LogQuery(), stimHome: StimHome.path(environment: environment), connection: (client, "/tmp/stim"), cwd: "/app")
    await settle()
    socket.answer("logs.subscribe", .object(["subscription": .string("s1")]))
    await settle()
    logs(socket, "s1", "before")
    await waitUntil { shown.contains("before") }
    #expect(shown == ["before"])
    socket.reply([
      "event": .string("error"), "subscription": .string("s1"),
      "error": .object([
        "code": .string("logs-failed"), "message": .string("retry"),
      ]),
    ])
    let retryNow = try #require(retry)
    retryNow()
    await settle()
    socket.answer("logs.subscribe", .object(["subscription": .string("s2")]))
    await settle()
    logs(socket, "s2", "after")
    await waitUntil { shown.contains("after") }
    #expect(shown == ["after"])
    #expect(resets == 2)
    follower.stop()
    await settle()
    socket.answer("unsubscribe", .object([:]))
  }

  @Test func buildQueriesRetainSourceFiltersAndRefuseAnotherHomeWithoutCLI() async throws {
    let (client, socket) = try await connection()
    defer { client.stop() }
    var failure: String?
    let follower = LogFollower { if case .failed(let reason) = $0 { failure = reason } }
    var query = try #require(LogQuery.build(platform: "ios", slot: "ipad", startedAt: "2026-10-02T12:00:00Z"))
    query.sources.insert(.agent)
    follower.start(
      query, stimHome: StimHome.path(environment: environment), connection: (client, "/tmp/another-home"), cwd: "/app")
    #expect(failure != nil)
    #expect(socket.sent.count == 1)
    follower.start(query, stimHome: StimHome.path(environment: environment), connection: (client, "/tmp/stim"), cwd: "/app")
    await settle()
    let request = try #require(socket.sent.last)
    #expect(request["method"] == .string("desktop.logs.subscribe"))
    #expect(
      request["params"]
        == .object([
          "workspace": .string("/app"), "sources": .array([.string("build"), .string("agent")]),
        ]))
    socket.answer("desktop.logs.subscribe", .object(["subscription": .string("s1")]))
    await settle()
    socket.reply([
      "event": .string("error"), "subscription": .string("s1"),
      "error": .object(["code": .string("logs-failed"), "message": .string("read failed")]),
    ])
    #expect(failure == "read failed")
    follower.stop()
    await settle()
    socket.answer("unsubscribe", .object([:]))
    #expect(client.isOpen)
  }

  @Test func stoppingAllAndDeinitializingReleaseOnlyTheirSubscriptions() async throws {
    let (client, socket) = try await connection()
    defer { client.stop() }
    var follower: LogFollower? = LogFollower { _ in }
    follower?.start(LogQuery(), stimHome: StimHome.path(environment: environment), connection: (client, "/tmp/stim"), cwd: "/app")
    await settle()
    socket.answer("logs.subscribe", .object(["subscription": .string("s1")]))
    await settle()
    follower = nil
    await settle()
    #expect(socket.sent.last?["method"] == .string("unsubscribe"))
    socket.answer("unsubscribe", .object([:]))
    let others = [LogFollower { _ in }, LogFollower { _ in }]
    for (index, other) in others.enumerated() {
      other.start(LogQuery(), stimHome: StimHome.path(environment: environment), connection: (client, "/tmp/stim"), cwd: "/app")
      await settle()
      socket.answer("logs.subscribe", .object(["subscription": .string("s\(index + 2)")]))
      await settle()
    }
    LogFollower.stopAll()
    await settle()
    #expect(socket.sent.filter { $0["method"] == .string("unsubscribe") }.count == 3)
    #expect(client.isOpen)
  }
}
