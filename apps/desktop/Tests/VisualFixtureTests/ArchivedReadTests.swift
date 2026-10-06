import Foundation
import StimKit
import XCTest

@testable import StimDesktop

@MainActor final class ArchivedReadTests: XCTestCase {
  private func settle() async {
    for _ in 0..<30 { await Task.yield() }
  }

  private func connection() async throws -> (ServerClient, ArchiveTransport) {
    var socket: ArchiveTransport?
    let client = ServerClient(
      endpoint: URL(string: "ws://127.0.0.1:7787")!, clientName: "Archive test", clientVersion: "1",
      auth: { .device(token: "test") },
      transport: { _, onEvent in
        let next = ArchiveTransport(onEvent: onEvent)
        socket = next
        return next
      })
    client.start()
    await settle()
    let transport = try XCTUnwrap(socket)
    transport.answer(
      try transport.take("hello"),
      .object([
        "protocol": .number(1), "server": .object(["name": .string("Mac"), "version": .string("1"), "stim": .string("1")]),
        "capabilities": .array([.string("read")]),
      ]))
    await settle()
    return (client, transport)
  }

  private func records(_ slots: [String]) -> JSONValue {
    .object([
      "records": .array(
        slots.enumerated().map { index, slot in
          .object([
            "ts": .number(Double(index + 1000)), "src": .string("client"), "level": .string("info"),
            "msg": .string(slot), "slot": .string(slot),
          ])
        })
    ])
  }

  func testArchiveLogsShowLoadingResetScrollAndKeepKnownSlotsAcrossFilters() async throws {
    let (client, socket) = try await connection()
    defer { client.stop() }
    let archive = try PlaygroundFixtures.make(.ready).archive
    let model = LogsModel()
    let query = LogQuery()
    var filtered = query
    filtered.slot = "fold"
    var revealed: [Int] = []
    model.onChange = { if case .reveal(let row) = $0 { revealed.append(row) } }
    model.pinnedToLatest = false
    model.reveal(at: 1000, in: filtered)
    let first = Task { await model.loadArchive(archive, query: query, server: client) }
    await settle()
    XCTAssertEqual(model.phase, .loading)
    XCTAssertTrue(model.pinnedToLatest)
    socket.answer(try socket.take("logs.query"), records(["default", "fold"]))
    await first.value
    XCTAssertEqual(model.phase, .loaded)
    XCTAssertEqual(model.archiveSlots, ["default", "fold"])
    model.pinnedToLatest = false
    let second = Task { await model.loadArchive(archive, query: filtered, server: client) }
    await settle()
    XCTAssertTrue(model.pinnedToLatest)
    socket.answer(try socket.take("logs.query"), records(["fold"]))
    await second.value
    XCTAssertEqual(model.archiveSlots, ["default", "fold"])
    XCTAssertTrue(revealed.isEmpty)
    XCTAssertTrue(model.pinnedToLatest)
    var other = archive
    other.id = "other"
    let third = Task { await model.loadArchive(other, query: query, server: client) }
    await settle()
    socket.answer(try socket.take("logs.query"), records(["tablet"]))
    await third.value
    XCTAssertEqual(model.archiveSlots, ["tablet"])
  }

  func testBusyLogsRetryWhileLoadingAndStopAfterFourAttempts() async throws {
    let (client, socket) = try await connection()
    defer { client.stop() }
    let archive = try PlaygroundFixtures.make(.ready).archive
    let model = LogsModel()
    let first = Task { await model.loadArchive(archive, query: LogQuery(), server: client) }
    await settle()
    socket.refuse(try socket.take("logs.query"), code: "limit-exceeded", message: "A connection can run 4 requests at a time.")
    XCTAssertEqual(model.phase, .loading)
    try await Task.sleep(for: .milliseconds(300))
    socket.answer(try socket.take("logs.query"), records(["default"]))
    await first.value
    XCTAssertEqual(model.phase, .loaded)
    XCTAssertEqual(model.count, 1)
    let exhausted = Task { await model.loadArchive(archive, query: LogQuery(), server: client) }
    await settle()
    for attempt in 0..<4 {
      socket.refuse(try socket.take("logs.query"), code: "limit-exceeded", message: "A connection can run 4 requests at a time.")
      if attempt < 3 { try await Task.sleep(for: .milliseconds(300)) }
    }
    await exhausted.value
    XCTAssertEqual(model.phase, .ended("A connection can run 4 requests at a time."))
    XCTAssertTrue(socket.requests.isEmpty)
  }

  func testBusyReplaySubscriptionRetriesAndUnsubscribingStopsRetries() async throws {
    let (client, socket) = try await connection()
    defer { client.stop() }
    var subscribed = false
    var errors: [String] = []
    let subscribe = {
      client.subscribe(
        "frames.subscribe", params: { ["archive": .string("ended"), "platform": .string("ios")] },
        onSubscribed: { _ in subscribed = true }, onEvent: { errors.append($0.name) }, onVideo: { _ in })
    }
    let unsubscribe = subscribe()
    await settle()
    socket.refuse(
      try socket.take("frames.subscribe"), code: "limit-exceeded", message: "A connection can run 4 requests at a time.")
    try await Task.sleep(for: .milliseconds(300))
    socket.answer(try socket.take("frames.subscribe"), .object(["subscription": .string("frames"), "video": .string("h264")]))
    await settle()
    XCTAssertTrue(subscribed)
    XCTAssertTrue(errors.isEmpty)
    unsubscribe()
    await settle()
    socket.answer(try socket.take("unsubscribe"), .object([:]))
    let cancel = subscribe()
    await settle()
    socket.refuse(
      try socket.take("frames.subscribe"), code: "limit-exceeded", message: "A connection can run 4 requests at a time.")
    cancel()
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertTrue(socket.requests.isEmpty)
    XCTAssertTrue(errors.isEmpty)
  }

  func testReplayPlatformsAreProbedOneAtATimeEvenWhenOneIsRefused() async throws {
    let (client, socket) = try await connection()
    defer { client.stop() }
    let model = ArchivedReplayModel(archive: "ended")
    defer { model.stop() }
    let read = Task { await model.connect(client) }
    let empty: JSONValue = .object([
      "enabled": .bool(true), "recording": .bool(false), "spans": .array([]), "markers": .array([]),
    ])
    for platform in ["ios", "android", "web"] {
      await settle()
      let request = try socket.take("replay.range")
      XCTAssertEqual(
        request["params"], .object(["archive": .string("ended"), "platform": .string(platform), "slot": .string("default")]))
      XCTAssertTrue(socket.requests.isEmpty)
      if platform == "android" {
        socket.refuse(request, code: "bad-request", message: "This archive is unavailable.")
      } else {
        socket.answer(request, empty)
      }
    }
    await read.value
    XCTAssertNotNil(model.controllers[0].range)
    XCTAssertEqual(model.controllers[1].error, "This archive is unavailable.")
    XCTAssertNotNil(model.controllers[2].range)
    XCTAssertTrue(socket.requests.isEmpty)
  }
}

@MainActor private final class ArchiveTransport: ServerTransport {
  var requests: [[String: JSONValue]] = []
  let onEvent: @MainActor (ServerTransportEvent) -> Void

  init(onEvent: @escaping @MainActor (ServerTransportEvent) -> Void) { self.onEvent = onEvent }

  func send(_ text: String) {
    guard case .object(let message) = try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { return }
    requests.append(message)
  }

  func close() {}

  func take(_ method: String) throws -> [String: JSONValue] {
    let index = try XCTUnwrap(requests.firstIndex { $0["method"] == .string(method) })
    return requests.remove(at: index)
  }

  func answer(_ request: [String: JSONValue], _ value: JSONValue) {
    reply(["id": request["id"]!, "result": value])
  }

  func refuse(_ request: [String: JSONValue], code: String, message: String) {
    reply(["id": request["id"]!, "error": .object(["code": .string(code), "message": .string(message)])])
  }

  private func reply(_ message: [String: JSONValue]) {
    onEvent(.text(String(decoding: try! JSONEncoder().encode(JSONValue.object(message)), as: UTF8.self)))
  }
}
