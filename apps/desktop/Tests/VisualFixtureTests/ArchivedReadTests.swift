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
      try await transport.take("hello"),
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
    socket.answer(try await socket.take("logs.query"), records(["default", "fold"]))
    await first.value
    XCTAssertEqual(model.phase, .loaded)
    XCTAssertEqual(model.archiveSlots, ["default", "fold"])
    model.pinnedToLatest = false
    let second = Task { await model.loadArchive(archive, query: filtered, server: client) }
    await settle()
    XCTAssertTrue(model.pinnedToLatest)
    socket.answer(try await socket.take("logs.query"), records(["fold"]))
    await second.value
    XCTAssertEqual(model.archiveSlots, ["default", "fold"])
    XCTAssertTrue(revealed.isEmpty)
    XCTAssertTrue(model.pinnedToLatest)
    var other = archive
    other.id = "other"
    let third = Task { await model.loadArchive(other, query: query, server: client) }
    await settle()
    socket.answer(try await socket.take("logs.query"), records(["tablet"]))
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
    socket.refuse(
      try await socket.take("logs.query"), code: "limit-exceeded", message: "A connection can run 4 requests at a time.")
    XCTAssertEqual(model.phase, .loading)
    try await Task.sleep(for: .milliseconds(300))
    socket.answer(try await socket.take("logs.query"), records(["default"]))
    await first.value
    XCTAssertEqual(model.phase, .loaded)
    XCTAssertEqual(model.count, 1)
    let exhausted = Task { await model.loadArchive(archive, query: LogQuery(), server: client) }
    await settle()
    for attempt in 0..<4 {
      socket.refuse(
        try await socket.take("logs.query"), code: "limit-exceeded", message: "A connection can run 4 requests at a time.")
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
      try await socket.take("frames.subscribe"), code: "limit-exceeded", message: "A connection can run 4 requests at a time.")
    try await Task.sleep(for: .milliseconds(300))
    socket.answer(
      try await socket.take("frames.subscribe"), .object(["subscription": .string("frames"), "video": .string("h264")]))
    await settle()
    XCTAssertTrue(subscribed)
    XCTAssertTrue(errors.isEmpty)
    unsubscribe()
    await settle()
    socket.answer(try await socket.take("unsubscribe"), .object([:]))
    let cancel = subscribe()
    await settle()
    socket.refuse(
      try await socket.take("frames.subscribe"), code: "limit-exceeded", message: "A connection can run 4 requests at a time.")
    cancel()
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertTrue(socket.requests.isEmpty)
    XCTAssertTrue(errors.isEmpty)
  }

  func testArchiveDetailRetriesBusyReadsAndDecodesHistoryWithoutTargetingReusedWorkspace() async throws {
    let (client, socket) = try await connection()
    defer { client.stop() }
    let read = Task { try await client.archiveDetail(ArchiveDetailRequest(archive: "ended")) }
    let request = try await socket.take("archive.detail")
    XCTAssertEqual(request["params"], .object(["archive": .string("ended")]))
    socket.refuse(request, code: "limit-exceeded", message: "Busy")
    let retry = try await socket.take("archive.detail")
    XCTAssertEqual(retry["params"], request["params"])
    let result = try JSONDecoder().decode(
      JSONValue.self,
      from: Data(
        #"""
        {"builds":{"ios":[{"platform":"ios","status":"failed","cacheHit":false,
        "startedAt":"2026-10-04T10:00:00Z","result":"failed","slot":"default",
        "phases":{"compile":42000}}]},"recordings":[
        {"platform":"android","slot":"fold","spans":[{"start":1000,"end":2000}]}]}
        """#.utf8))
    socket.answer(retry, result)
    let detail = try await read.value
    XCTAssertEqual(detail.builds.ios?.first?.phases, ["compile": 42000])
    XCTAssertEqual(detail.recordings.first?.slot, "fold")
    XCTAssertTrue(socket.requests.isEmpty)
  }

  func testUnavailableArchiveDetailKeepsTheSummaryForAnOlderServer() async throws {
    let (client, socket) = try await connection()
    defer { client.stop() }
    let archive = try PlaygroundFixtures.make(.ready).archive
    let read = Task { try await client.archiveDetail(ArchiveDetailRequest(archive: archive.id)) }
    socket.refuse(try await socket.take("archive.detail"), code: "unknown-method", message: "Unknown request")
    var detail: ArchiveDetail?
    do {
      detail = try await read.value
      XCTFail("An older server must refuse archive.detail")
    } catch {
      XCTAssertEqual(archivedReadError(error, content: "build history"), "Unknown request")
    }
    let page = ArchivedPage(archive: archive, detail: detail, now: Date())
    XCTAssertEqual(page.workspace.lastBuilds?.ios, archive.builds.last)
    XCTAssertTrue(socket.requests.isEmpty)
  }

  func testReplayUsesEveryRetainedSlotAndNeverProbesUnlistedPlatforms() async throws {
    let (client, socket) = try await connection()
    defer { client.stop() }
    let detail = try JSONDecoder().decode(
      ArchiveDetail.self,
      from: Data(
        #"""
        {"builds":{},"recordings":[
        {"platform":"ios","slot":"default","spans":[{"start":1000,"end":2000}]},
        {"platform":"ios","slot":"tablet","spans":[{"start":3000,"end":4000}]}]}
        """#.utf8))
    let model = ArchivedReplayModel(archive: "ended", recordings: detail.recordings)
    defer { model.stop() }
    let read = Task { await model.connect(client) }
    for slot in ["default", "tablet"] {
      let request = try await socket.take("replay.range")
      XCTAssertEqual(
        request["params"],
        .object([
          "archive": .string("ended"), "platform": .string("ios"), "slot": .string(slot),
        ]))
      socket.answer(
        request,
        .object([
          "enabled": .bool(true), "recording": .bool(false), "spans": .array([]), "markers": .array([]),
        ]))
    }
    await read.value
    XCTAssertTrue(socket.requests.isEmpty)
  }

  func testRealArchivePreservesAllBuildsAndOpensItsRetainedReplay() async throws {
    let now = Date(timeIntervalSince1970: 1791356400)
    let fixture = try PlaygroundFixtures.realArchive(now: now)
    let page = ArchivedPage(archive: fixture.archive, detail: fixture.archiveDetail, now: now)
    let builds = try XCTUnwrap(page.workspace.builds?.ios)
    XCTAssertEqual(builds.map { $0.build.durationMs }, [13140, 29746, 66197, 9406, 129383])
    XCTAssertEqual(builds.map { $0.build.offloadedTo }, [nil, "janics-mac-mini", nil, nil, "janics-mac-mini"])
    XCTAssertEqual(builds.map(\.result), ["failed", "succeeded", "succeeded", "failed", "succeeded"])
    XCTAssertEqual(builds.map { $0.build.cacheSkipped }, [true, true, true, true, true])
    XCTAssertEqual(
      builds.filter { $0.result == "failed" }.map { $0.build.errorCode }, ["STIM_BUILD_FAILED", "STIM_BUILD_FAILED"])
    XCTAssertEqual(builds.last?.phases["pods"], 67897)
    XCTAssertEqual(page.offloadedBuilds, 2)
    XCTAssertEqual(page.cacheHits, 0)
    XCTAssertEqual(page.workspace.lastBuilds?.ios?.durationMs, 13140)
    XCTAssertEqual(
      fixture.archiveDetail.recordings[0].spans,
      [
        ReplaySpan(start: 1791346346610, end: 1791346357977),
        ReplaySpan(start: 1791346446117, end: 1791346446586),
        ReplaySpan(start: 1791346655074, end: 1791346655625),
      ])
    let (client, socket) = try await connection()
    defer { client.stop() }
    let model = ArchivedReplayModel(archive: fixture.archive.id, recordings: page.recordings)
    defer { model.stop() }
    let read = Task { await model.connect(client) }
    let range = try await socket.take("replay.range")
    XCTAssertEqual(
      range["params"], .object(["archive": .string(fixture.archive.id), "platform": .string("ios"), "slot": .string("default")]))
    socket.answer(
      range,
      .object([
        "enabled": .bool(false), "recording": .bool(false), "markers": .array([]),
        "spans": .array(page.recordings[0].spans.map { .object(["start": .number($0.start), "end": .number($0.end)]) }),
      ]))
    await read.value
    let controller = try XCTUnwrap(model.controllers.first)
    XCTAssertNotNil(controller.timeline)
    controller.seek(at: 1791346346610, rate: 0)
    let subscribe = try await socket.take("frames.subscribe")
    guard case .object(let params) = subscribe["params"] else {
      XCTFail("Missing replay params")
      return
    }
    XCTAssertEqual(params["archive"], .string(fixture.archive.id))
    XCTAssertNil(params["workspace"])
    XCTAssertEqual(params["at"], .number(1791346346610))
    socket.answer(subscribe, .object(["subscription": .string("real-replay"), "video": .string("h264")]))
    await settle()
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
      let request = try await socket.take("replay.range")
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

private struct ArchiveTransportTimeout: Error {}

@MainActor private final class ArchiveTransport: ServerTransport {
  var requests: [[String: JSONValue]] = []
  let onEvent: @MainActor (ServerTransportEvent) -> Void

  init(onEvent: @escaping @MainActor (ServerTransportEvent) -> Void) { self.onEvent = onEvent }

  func send(_ text: String) {
    guard case .object(let message) = try! JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) else { return }
    requests.append(message)
  }

  func close() {}

  func take(_ method: String) async throws -> [String: JSONValue] {
    for _ in 0..<100 {
      if let index = requests.firstIndex(where: { $0["method"] == .string(method) }) { return requests.remove(at: index) }
      try await Task.sleep(for: .milliseconds(50))
    }
    XCTFail("No \(method) request arrived")
    throw ArchiveTransportTimeout()
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
