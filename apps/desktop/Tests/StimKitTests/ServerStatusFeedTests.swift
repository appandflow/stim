import Foundation
import Testing

@testable import StimKit

@Suite @MainActor struct ServerStatusFeedTests {
  private let hello: JSONValue = .object([
    "protocol": .number(1), "server": .object(["name": .string("Mac"), "version": .string("1.20.0"), "stim": .string("1.20.0")]),
    "capabilities": .array([.string("read")]), "device": .object(["id": .string("d1"), "name": .string("Stim Desktop")]),
  ])

  private func status(live: Int) -> JSONValue {
    .object([
      "environments": .array([]),
      "capacity": .object([
        "liveCount": .number(Double(live)), "committedMb": .number(0), "totalMemoryMb": .number(0),
        "overCapacity": .bool(false),
      ]),
    ])
  }

  private func event(_ payload: JSONValue, subscription: String = "s1") -> [String: JSONValue] {
    ["event": .string("status"), "subscription": .string(subscription), "payload": payload, "usage": .object([:])]
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
    var live: [Int] = []
    var delivering: [Bool] = []
  }

  private func feed(_ recorder: Recorder) -> ServerStatusFeed {
    ServerStatusFeed(
      onPayload: { result in
        if case .success(let payload) = result { recorder.live.append(payload.capacity?.liveCount ?? -1) }
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

  @Test func theServersStatusPayloadReachesTheStoreAndMarksTheFeedDelivering() async throws {
    let (client, socket) = try await openClient()
    defer { client.stop() }
    let recorder = Recorder()
    let feed = feed(recorder)
    feed.use(client)
    await settle()
    #expect(socket.sent.last?["method"] == .string("status.subscribe"))
    socket.answer("status.subscribe", .object(["subscription": .string("s1")]))
    await settle()
    #expect(recorder.delivering.isEmpty)

    socket.reply(event(status(live: 3)))
    #expect(await until { recorder.live == [3] })
    #expect(recorder.delivering == [true])
    socket.reply(event(status(live: 4)))
    #expect(await until { recorder.live == [3, 4] })
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
    socket.answer("status.subscribe", .object(["subscription": .string("s1")]))
    await settle()
    socket.reply(event(status(live: 1)))
    #expect(await until { recorder.delivering == [true] })

    socket.reply([
      "event": .string("error"), "subscription": .string("s1"),
      "error": .object(["code": .string("status-failed"), "message": .string("stim status --watch exited")]),
    ])
    #expect(await until { recorder.delivering == [true, false] })

    let retry = try #require(retries.value.first)
    retry()
    await settle()
    socket.answer("status.subscribe", .object(["subscription": .string("s2")]))
    await settle()
    socket.reply(event(status(live: 2), subscription: "s2"))
    #expect(await until { recorder.live == [1, 2] })
    #expect(recorder.delivering == [true, false, true])
  }

  @Test func losingTheServerStopsTheFeedSoTheStoreFallsBackAndNoLatePayloadIsShown() async throws {
    let (client, socket) = try await openClient()
    defer { client.stop() }
    let recorder = Recorder()
    let feed = feed(recorder)
    feed.use(client)
    await settle()
    socket.answer("status.subscribe", .object(["subscription": .string("s1")]))
    await settle()
    socket.reply(event(status(live: 1)))
    #expect(await until { recorder.delivering == [true] })

    feed.use(nil)
    #expect(recorder.delivering == [true, false])
    socket.reply(event(status(live: 9)))
    await settle()
    try? await Task.sleep(nanoseconds: 100_000_000)
    #expect(recorder.live == [1])
    #expect(recorder.delivering == [true, false])
  }

  @Test func usingTheSameClientAgainDoesNotSubscribeTwice() async throws {
    let (client, socket) = try await openClient()
    defer { client.stop() }
    let feed = feed(Recorder())
    feed.use(client)
    feed.use(client)
    await settle()
    #expect(socket.sent.filter { $0["method"] == .string("status.subscribe") }.count == 1)
  }
}
