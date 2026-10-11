import Foundation
import Testing

@testable import StimKit

@Suite @MainActor struct ServerStatusFeedTests {
  private let hello: JSONValue = .object([
    "protocol": .number(1), "server": .object(["name": .string("Mac"), "version": .string("1.20.0"), "stim": .string("1.20.0")]),
    "capabilities": .array([.string("read")]), "device": .object(["id": .string("d1"), "name": .string("Stim Desktop")]),
  ])

  private func workspaces(_ paths: [String], seq: Int = 0, subscription: String = "s1") -> [String: JSONValue] {
    let summaries: [JSONValue] = paths.map {
      .object([
        "path": .string($0), "live": .bool(false), "warnings": .array([]), "issues": .array([]),
        "memoryMb": .number(0),
      ])
    }
    return [
      "event": .string("workspaces"), "subscription": .string(subscription), "seq": .number(Double(seq)),
      "snapshot": .object([
        "workspaces": .array(summaries), "worktrees": .array([]),
        "archived": .object(["count": .number(0), "bytes": .number(0), "newest": .array([])]),
      ]),
    ]
  }

  private func machine(live: Int, subscription: String = "s2") -> [String: JSONValue] {
    [
      "event": .string("machine"), "subscription": .string(subscription), "seq": .number(0),
      "machine": .object([
        "capacity": .object([
          "liveCount": .number(Double(live)), "committedMb": .number(0), "totalMemoryMb": .number(0),
          "overCapacity": .bool(false),
        ]),
        "machine": .null, "deviceLeases": .array([]), "simctlAvailable": .bool(true), "maintenance": .null,
      ]),
    ]
  }

  private func subscribe(_ socket: FakeTransport, workspaces: String = "s1", machine: String = "s2") async {
    socket.answer("workspaces.subscribe", .object(["subscription": .string(workspaces)]))
    socket.answer("machine.subscribe", .object(["subscription": .string(machine)]))
    await settle()
  }

  private func openClient(retries: Box<[@MainActor () -> Void]> = Box([])) async throws -> (ServerClient, FakeTransport) {
    var transport: FakeTransport?
    let client = ServerClient(
      endpoint: URL(string: "ws://127.0.0.1:7787")!, clientName: "Stim Desktop", clientVersion: "1",
      auth: { .device(token: "test-token") },
      transport: { _, onEvent in
        let next = FakeTransport(onEvent: onEvent)
        transport = next
        return next
      },
      scheduler: { _, work in
        retries.value.append(work)
        return {}
      })
    client.start()
    await settle()
    let socket = try #require(transport)
    socket.answer("hello", hello)
    await settle()
    return (client, socket)
  }

  private final class Box<Value> {
    var value: Value
    init(_ value: Value) { self.value = value }
  }

  private final class Recorder {
    var payloads: [StatusPayload] = []
    var delivering: [Bool] = []
    var live: [Int] { payloads.map { $0.capacity?.liveCount ?? -1 } }
    var paths: [[String]] { payloads.map { $0.environments.map(\.path) } }
  }

  private func feed(_ recorder: Recorder) -> ServerStatusFeed {
    ServerStatusFeed(
      onPayload: { result in
        if case .success(let payload) = result { recorder.payloads.append(payload) }
      },
      onDelivering: { recorder.delivering.append($0) })
  }

  private func until(_ condition: () -> Bool) async -> Bool {
    for _ in 0..<400 {
      if condition() { return true }
      try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return condition()
  }

  @Test func theWorkspaceListAndMachineReachTheStoreAndMarkTheFeedDelivering() async throws {
    let (client, socket) = try await openClient()
    defer { client.stop() }
    let recorder = Recorder()
    let feed = feed(recorder)
    feed.use(client)
    await settle()
    #expect(socket.sent.compactMap { $0["method"]?.string }.suffix(2) == ["workspaces.subscribe", "machine.subscribe"])
    await subscribe(socket)
    #expect(recorder.delivering.isEmpty)

    socket.reply(workspaces(["/w/a"]))
    #expect(await until { recorder.paths.last == ["/w/a"] })
    #expect(recorder.delivering == [true])
    socket.reply(machine(live: 3))
    #expect(await until { recorder.live.last == 3 })
    socket.reply([
      "event": .string("workspaces"), "subscription": .string("s1"), "seq": .number(1),
      "workspaces": .object(["upsert": .array([]), "remove": .array([.string("/w/a")])]),
    ])
    #expect(await until { recorder.paths.last == [] })
    #expect(recorder.delivering == [true])
  }

  @Test func aServerErrorMakesTheStoreRunItsOwnWatcherUntilTheServerDeliversAgain() async throws {
    let retries = Box<[@MainActor () -> Void]>([])
    let (client, socket) = try await openClient(retries: retries)
    defer { client.stop() }
    let recorder = Recorder()
    let feed = feed(recorder)
    feed.use(client)
    await settle()
    await subscribe(socket)
    socket.reply(workspaces(["/w/a"]))
    #expect(await until { recorder.delivering == [true] })

    socket.reply([
      "event": .string("error"), "subscription": .string("s1"),
      "error": .object(["code": .string("status-failed"), "message": .string("the status worker exited")]),
    ])
    #expect(await until { recorder.delivering == [true, false] })

    let retry = try #require(retries.value.first)
    retry()
    await settle()
    socket.answer("workspaces.subscribe", .object(["subscription": .string("s3")]))
    await settle()
    socket.reply(workspaces(["/w/b"], subscription: "s3"))
    #expect(await until { recorder.paths.last == ["/w/b"] })
    #expect(recorder.delivering == [true, false, true])
  }

  @Test func aServerWithoutTheViewsLeavesTheStoreOnItsOwnWatcher() async throws {
    let (client, socket) = try await openClient()
    defer { client.stop() }
    let recorder = Recorder()
    let feed = feed(recorder)
    feed.use(client)
    await settle()
    socket.refuse("workspaces.subscribe", code: "unknown-method")
    socket.refuse("machine.subscribe", code: "unknown-method")
    await settle()
    try? await Task.sleep(nanoseconds: 50_000_000)
    #expect(recorder.payloads.isEmpty)
    #expect(recorder.delivering.allSatisfy { !$0 })
  }

  @Test func aMissedEventSubscribesAgainWithoutLeavingTheServer() async throws {
    let (client, socket) = try await openClient()
    defer { client.stop() }
    let recorder = Recorder()
    let feed = feed(recorder)
    feed.use(client)
    await settle()
    await subscribe(socket)
    socket.reply(workspaces(["/w/a"]))
    #expect(await until { recorder.delivering == [true] })
    let before = socket.sent.filter { $0["method"] == .string("workspaces.subscribe") }.count

    socket.reply([
      "event": .string("workspaces"), "subscription": .string("s1"), "seq": .number(3),
      "workspaces": .object(["upsert": .array([]), "remove": .array([.string("/w/a")])]),
    ])
    #expect(await until { socket.sent.filter { $0["method"] == .string("workspaces.subscribe") }.count == before + 1 })
    await subscribe(socket, workspaces: "s3", machine: "s4")
    socket.reply(workspaces(["/w/c"], subscription: "s3"))
    #expect(await until { recorder.paths.last == ["/w/c"] })
    #expect(recorder.delivering == [true])
  }

  @Test func theShownWorkspaceCarriesItsFullEnvironment() async throws {
    let (client, socket) = try await openClient()
    defer { client.stop() }
    let recorder = Recorder()
    let feed = feed(recorder)
    feed.use(client)
    await settle()
    await subscribe(socket)
    socket.reply(workspaces(["/w/a"]))
    #expect(await until { recorder.delivering == [true] })

    feed.follow(["/w/a"])
    await settle()
    let request = try #require(socket.sent.last { $0["method"] == .string("workspace.subscribe") })
    #expect(request["params"] == .object(["workspace": .string("/w/a")]))
    socket.answer("workspace.subscribe", .object(["subscription": .string("s3")]))
    await settle()
    socket.reply([
      "event": .string("workspace"), "subscription": .string("s3"), "seq": .number(0),
      "environment": .object([
        "path": .string("/w/a"), "live": .bool(false), "warnings": .array([]), "issues": .array([]),
        "memoryMb": .number(0), "logs": .object(["dir": .string("/logs"), "errorsSinceMarker": .number(4)]),
      ]),
    ])
    #expect(await until { recorder.payloads.last?.environments.first?.logs?.dir == "/logs" })

    feed.follow([])
    #expect(await until { recorder.payloads.last?.environments.first?.logs == nil })
  }

  @Test func theArchivesAreReadPageByPageAfterTheirSummaryChanges() async throws {
    let (client, socket) = try await openClient()
    defer { client.stop() }
    let recorder = Recorder()
    let feed = feed(recorder)
    feed.use(client)
    await settle()
    await subscribe(socket)
    socket.reply(workspaces(["/w/a"]))
    #expect(await until { socket.sent.contains { $0["method"] == .string("archived.list") } })
    func archive(_ id: String) -> JSONValue {
      .object([
        "id": .string(id), "projectRoot": .string("/w/\(id)"), "project": .string(id), "workspace": .string("\(id)--0"),
        "worktree": .object([:]), "removedAt": .string("2026-10-01T00:00:00Z"), "removedBy": .string("gc"),
        "builds": .object(["count": .number(0), "last": .null, "lastErrorCount": .number(0)]), "agents": .array([]),
        "bytes": .object([
          "logs": .number(0), "recordings": .number(0), "agentActions": .number(0), "record": .number(1),
          "total": .number(1),
        ]), "expires": .object([:]), "version": .number(1),
      ])
    }
    let usage: JSONValue = .object([
      "count": .number(2), "bytes": .number(2),
      "byKind": .object(["logs": .number(0), "recordings": .number(0), "agentActions": .number(0), "record": .number(2)]),
    ])
    socket.answer(
      "archived.list", .object(["archived": .array([archive("b")]), "usage": usage, "next": .string("cursor")]))
    #expect(
      await until {
        socket.sent.last { $0["method"] == .string("archived.list") }?["params"]
          == .object(["before": .string("cursor")])
      })
    socket.answer("archived.list", .object(["archived": .array([archive("a")]), "usage": usage, "next": .null]))
    #expect(await until { recorder.payloads.last?.archived?.map(\.id) == ["b", "a"] })
  }

  @Test func aFailedArchivesReadIsRetriedWhenTheViewsComeBack() async throws {
    let retries = Box<[@MainActor () -> Void]>([])
    let (client, socket) = try await openClient(retries: retries)
    defer { client.stop() }
    let feed = feed(Recorder())
    feed.use(client)
    await settle()
    await subscribe(socket)
    socket.reply(workspaces(["/w/a"]))
    let reads = { socket.sent.filter { $0["method"] == .string("archived.list") }.count }
    #expect(await until { reads() == 1 })
    socket.refuse("archived.list", code: "status-failed")
    socket.reply([
      "event": .string("error"), "subscription": .string("s1"),
      "error": .object(["code": .string("status-failed"), "message": .string("the status worker exited")]),
    ])
    await settle()

    let retry = try #require(retries.value.first)
    retry()
    await settle()
    socket.answer("workspaces.subscribe", .object(["subscription": .string("s3")]))
    await settle()
    socket.reply(workspaces(["/w/a"], subscription: "s3"))
    #expect(await until { reads() == 2 })
  }

  @Test func losingTheServerStopsTheFeedSoTheStoreFallsBackAndNoLatePayloadIsShown() async throws {
    let (client, socket) = try await openClient()
    defer { client.stop() }
    let recorder = Recorder()
    let feed = feed(recorder)
    feed.use(client)
    await settle()
    await subscribe(socket)
    socket.reply(workspaces(["/w/a"]))
    #expect(await until { recorder.delivering == [true] })

    feed.use(nil)
    #expect(recorder.delivering == [true, false])
    socket.reply(workspaces(["/w/late"]))
    await settle()
    try? await Task.sleep(nanoseconds: 100_000_000)
    #expect(recorder.paths == [["/w/a"]])
    #expect(recorder.delivering == [true, false])
  }

  @Test func usingTheSameClientAgainDoesNotSubscribeTwice() async throws {
    let (client, socket) = try await openClient()
    defer { client.stop() }
    let feed = feed(Recorder())
    feed.use(client)
    feed.use(client)
    await settle()
    #expect(socket.sent.filter { $0["method"] == .string("workspaces.subscribe") }.count == 1)
  }
}
